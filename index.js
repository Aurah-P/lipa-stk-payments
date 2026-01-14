const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { Pool } = require("pg");

const app = express();
app.use(bodyParser.json());

// =======================
// DATABASE (Railway injects credentials)
// =======================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});

// =======================
// MPESA SANDBOX CONSTANTS
// =======================
const MPESA_BASE_URL = "https://sandbox.safaricom.co.ke";
const SHORTCODE = "174379";
const PASSKEY = "bfb279f9aa9bdbcf158e97dd71a467cd";

// =======================
// UTILITY FUNCTIONS
// =======================
function getTimestamp() {
  const d = new Date();
  return d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0") +
    String(d.getHours()).padStart(2, "0") +
    String(d.getMinutes()).padStart(2, "0") +
    String(d.getSeconds()).padStart(2, "0");
}

function getPassword(timestamp) {
  const str = SHORTCODE + PASSKEY + timestamp;
  return Buffer.from(str).toString("base64");
}

async function getAccessToken() {
  const auth = Buffer.from(
    process.env.MPESA_CONSUMER_KEY + ":" + process.env.MPESA_CONSUMER_SECRET
  ).toString("base64");

  const response = await axios.get(
    `${MPESA_BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    {
      headers: { Authorization: `Basic ${auth}` }
    }
  );

  return response.data.access_token;
}

async function initDb() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        transaction_id TEXT PRIMARY KEY,
        phone TEXT,
        amount INTEGER,
        status TEXT,
        mpesa_receipt TEXT
      );
    `);
    console.log("Database initialized");
  } catch (err) {
    console.error("Database init failed:", err.message);
  }
}

// =======================
// 1. STK PUSH ENDPOINT
// =======================
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount } = req.body;
    const timestamp = getTimestamp();
    const password = getPassword(timestamp);
    const token = await getAccessToken();

    const response = await axios.post(
      `${MPESA_BASE_URL}/mpesa/stkpush/v1/processrequest`,
      {
        BusinessShortCode: SHORTCODE,
        Password: password,
        Timestamp: timestamp,
        TransactionType: "CustomerPayBillOnline",
        Amount: amount,
        PartyA: phone,
        PartyB: SHORTCODE,
        PhoneNumber: phone,
        CallBackURL: `${process.env.BASE_URL}/callback`,
        AccountReference: "ESP8266",
        TransactionDesc: "ESP8266 Payment"
      },
      {
        headers: {
          Authorization: `Bearer ${token}`
        }
      }
    );

    const transactionId = response.data.CheckoutRequestID;

    await pool.query(
      "INSERT INTO transactions VALUES ($1,$2,$3,$4,$5)",
      [transactionId, phone, amount, "PENDING", null]
    );

    res.json({ transactionId, status: "PENDING" });

  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: "STK Push Failed" });
  }
});

// =======================
// 2. MPESA CALLBACK
// =======================
app.post("/callback", async (req, res) => {
  const stkCallback = req.body.Body.stkCallback;
  const transactionId = stkCallback.CheckoutRequestID;

  if (stkCallback.ResultCode === 0) {
    const receipt = stkCallback.CallbackMetadata.Item.find(
      i => i.Name === "MpesaReceiptNumber"
    ).Value;

    await pool.query(
      "UPDATE transactions SET status=$1, mpesa_receipt=$2 WHERE transaction_id=$3",
      ["SUCCESS", receipt, transactionId]
    );
  } else {
    await pool.query(
      "UPDATE transactions SET status=$1 WHERE transaction_id=$2",
      ["FAILED", transactionId]
    );
  }

  res.json({ ResultCode: 0, ResultDesc: "Accepted" });
});

// =======================
// 3. STATUS POLLING
// =======================
app.get("/status", async (req, res) => {
  const { transactionId } = req.query;

  const result = await pool.query(
    "SELECT status FROM transactions WHERE transaction_id=$1",
    [transactionId]
  );

  if (result.rows.length === 0) {
    return res.json({ status: "UNKNOWN" });
  }

  res.json({ status: result.rows[0].status });
});

// =======================
// SERVER START
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
  initDb();
});

