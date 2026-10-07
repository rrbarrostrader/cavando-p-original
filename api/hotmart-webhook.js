// Hotmart -> OpenAI Ads Conversions API
// Vercel Function (Node.js)
//
// Environment variable required:
// OPENAI_CONVERSION_API_KEY

const PIXEL_ID = "5ARgSkVtLyS5QfT66DHZGq";
const OPENAI_EVENTS_URL =
  `https://bzr.openai.com/v1/events?pid=${encodeURIComponent(PIXEL_ID)}`;

function getEventName(body) {
  return String(
    body?.event ||
    body?.event_name ||
    body?.eventName ||
    body?.type ||
    ""
  ).toUpperCase();
}

function isApprovedPurchase(body) {
  const eventName = getEventName(body);
  if (eventName === "PURCHASE_APPROVED") return true;

  const status = String(
    body?.data?.purchase?.status ||
    body?.purchase?.status ||
    ""
  ).toUpperCase();

  return status === "APPROVED";
}

function getTransactionId(body) {
  return String(
    body?.data?.purchase?.transaction ||
    body?.purchase?.transaction ||
    body?.data?.transaction ||
    body?.transaction ||
    body?.id ||
    ""
  ).trim();
}

// OpenAI requires timestamp_ms to be within the last 7 days.
// Hotmart's sandbox/test payload can contain intentionally old purchase dates
// (the sample currently sends approved_date/order_date from 2017).
// Prefer the webhook creation_date, which represents when Hotmart generated
// this notification. If that value is also invalid/old, use current server time.
function getTimestampMs(body) {
  const now = Date.now();
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  const creation = body?.creation_date ?? body?.creationDate;

  if (creation !== undefined && creation !== null && creation !== "") {
    let ts;

    if (typeof creation === "number") {
      ts = creation < 1e12 ? creation * 1000 : creation;
    } else {
      const numeric = Number(creation);
      if (Number.isFinite(numeric)) {
        ts = numeric < 1e12 ? numeric * 1000 : numeric;
      } else {
        const parsed = Date.parse(creation);
        if (!Number.isNaN(parsed)) ts = parsed;
      }
    }

    if (
      Number.isFinite(ts) &&
      ts <= now + 5 * 60 * 1000 &&
      ts >= now - sevenDaysMs
    ) {
      return Math.trunc(ts);
    }
  }

  return now;
}


function getOppref(body) {
  const sck = String(
    body?.data?.purchase?.origin?.sck ||
    body?.purchase?.origin?.sck ||
    body?.data?.purchase?.sck ||
    body?.purchase?.sck ||
    ""
  );

  const marker = "|oppref:";
  const index = sck.indexOf(marker);
  if (index === -1) return "";

  // oppref is opaque: return the exact value stored after our marker.
  return sck.slice(index + marker.length).trim();
}

function getSourceUrl(body) {
  const url =
    body?.data?.purchase?.checkout_url ||
    body?.data?.purchase?.checkoutUrl ||
    body?.purchase?.checkout_url ||
    body?.purchase?.checkoutUrl;

  if (typeof url === "string" && /^https?:\/\//i.test(url)) return url;

  return "https://livro.iabfapegma.com.br/";
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({
      ok: false,
      error: "method_not_allowed"
    });
  }

  const apiKey = process.env.OPENAI_CONVERSION_API_KEY;

  if (!apiKey) {
    console.error("OPENAI_CONVERSION_API_KEY is not configured.");
    return res.status(500).json({
      ok: false,
      error: "server_not_configured"
    });
  }

  const body = req.body || {};

  if (!isApprovedPurchase(body)) {
    return res.status(200).json({
      ok: true,
      ignored: true
    });
  }

  const transactionId = getTransactionId(body);

  if (!transactionId) {
    return res.status(400).json({
      ok: false,
      error: "missing_transaction_id"
    });
  }

  const eventId = `hotmart_${transactionId}`;
  const oppref = getOppref(body);

  const event = {
    id: eventId,
    type: "order_created",
    timestamp_ms: getTimestampMs(body),
    source_url: getSourceUrl(body),
    action_source: "web",
    data: {
      type: "contents"
    }
  };

  // OpenAI requires the original oppref value unchanged when available.
  if (oppref) event.oppref = oppref;

  const payload = {
    validate_only: false,
    events: [event]
  };

  try {
    const response = await fetch(OPENAI_EVENTS_URL, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    const responseText = await response.text();

    if (!response.ok) {
      console.error(
        "OpenAI Conversions API error:",
        response.status,
        responseText
      );

      return res.status(502).json({
        ok: false,
        error: "openai_conversion_api_error",
        status: response.status,
        openai_response: responseText
      });
    }

    return res.status(200).json({
      ok: true,
      forwarded: true,
      event_id: eventId
    });
  } catch (error) {
    console.error("Failed to call OpenAI Conversions API:", error);

    return res.status(500).json({
      ok: false,
      error: "forwarding_failed",
      message: String(error?.message || error)
    });
  }
};
