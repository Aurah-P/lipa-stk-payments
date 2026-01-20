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
const SHORTCODE = process.env.MPESA_SHORTCODE;
const PASSKEY = process.env.MPESA_PASSKEY;

// =======================
// UTILITY FUNCTIONS
// =======================
function getTimestamp() {
  const d = new Date();
  return (
    d.getFullYear().toString() +
    String(d.getMonth() + 1).padStart(2, "0") +
    String(d.getDate()).padStart(2, "0") +
    String(d.getHours()).padStart(2, "0") +
    String(d.getMinutes()).padStart(2, "0") +
    String(d.getSeconds()).padStart(2, "0")
  );
}

function getPassword(timestamp) {
  return Buffer.from(SHORTCODE + PASSKEY + timestamp).toString("base64");
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
}

// =======================
// 1. STK PUSH ENDPOINT
// =======================
app.post("/stkpush", async (req, res) => {
  try {
    const { phone, amount } = req.body;

    // ---- Input validation
    if (!phone || !amount || amount <= 0) {
      return res.status(200).json({
        status: "ERROR",
        code: "INVALID_INPUT",
        message: "Invalid phone number or amount.",
        safe: true,
        action: "REENTER"
      });
    }

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
        headers: { Authorization: `Bearer ${token}` }
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

    let errorResponse = {
      status: "ERROR",
      code: "NETWORK_DELAY",
      message: "Network delay. Please wait 30 seconds before retrying.",
      safe: true,
      action: "WAIT"
    };

    if (err.response?.status === 429) {
      errorResponse = {
        status: "ERROR",
        code: "DARAJA_RATE_LIMIT",
        message: "Too many requests. Please wait 1 minute before retrying.",
        safe: true,
        action: "WAIT"
      };
    }

    if (err.response?.status >= 500) {
      errorResponse = {
        status: "ERROR",
        code: "SERVICE_TEMPORARY_DOWN",
        message: "M-PESA service temporarily unavailable. Do not retry immediately.",
        safe: true,
        action: "WAIT"
      };
    }

    res.status(200).json(errorResponse);
  }
});

// =======================
// 2. MPESA CALLBACK
// =======================
app.post("/callback", async (req, res) => {
  const stkCallback = req.body?.Body?.stkCallback;

  if (!stkCallback) {
    return res.json({ ResultCode: 0, ResultDesc: "Invalid callback payload" });
  }

  const transactionId = stkCallback.CheckoutRequestID;

  if (stkCallback.ResultCode === 0) {
    const receiptItem = stkCallback.CallbackMetadata.Item.find(
      i => i.Name === "MpesaReceiptNumber"
    );

    const receipt = receiptItem ? receiptItem.Value : null;

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
app.get("/status/:transactionId", async (req, res) => {
  const { transactionId } = req.params;

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
// 4. TRANSACTION REHYDRATION
// =======================
app.get("/last-transaction", async (req, res) => {
  const result = await pool.query(`
    SELECT transaction_id, phone, amount, status
    FROM transactions
    ORDER BY transaction_id DESC
    LIMIT 1
  `);

  if (result.rows.length === 0) {
    return res.json({ status: "NONE" });
  }

  res.json(result.rows[0]);
});

// =======================
// SERVER START
// =======================
const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Backend running on port ${PORT}`);
  await initDb();
});
