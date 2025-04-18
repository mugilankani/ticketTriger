import puppeteer from "puppeteer";
import { genkit, z } from "genkit";
import { googleAI, gemini15Flash } from "@genkit-ai/googleai";
import nodemailer from "nodemailer";
import cron from "node-cron";
import { apiKey } from "genkit/context";

// --- Configuration ---
const RCB_TICKET_URL = "https://shop.royalchallengers.com/ticket";
const TARGET_MATCH = "Royal Challengers Bengaluru VS Chennai Super Kings";
const CRON_SCHEDULE = "*/2 * * * *";
const EMAIL_RECIPIENTS = ["mugilankani951@gmail.com", "guruvedhanth@gmail.com"];
const GMAIL_USER = process.env.GMAIL_USER ;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;

const ai = genkit({
  plugins: [googleAI({
    apiKey: process.env.GOOGLE_AI_API_KEY
  }
  )],
  model: gemini15Flash,
});

// --- Tool Definition ---
const sendEmailTool = ai.defineTool(
  {
    name: "sendEmailTool",
    description:
      "Sends email notifications about ticket availability for a specific match",
    inputSchema: z.object({
      message: z.string().describe("The content of the email body."),
      matchName: z
        .string()
        .describe(
          `The specific match the notification is for (e.g., ${TARGET_MATCH})`
        ),
    }),
    outputSchema: z.string(),
  },
  async (input) => {
    const { message, matchName } = input;
    console.log(
      `📧 Preparing to send emails about ${matchName} to`,
      EMAIL_RECIPIENTS
    );

    if (!GMAIL_USER || !GMAIL_APP_PASSWORD) {
      const errorMsg =
        "❌ Email credentials (GMAIL_USER, GMAIL_APP_PASSWORD) not configured.";
      console.error(errorMsg);
      return errorMsg;
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: GMAIL_USER,
        pass: GMAIL_APP_PASSWORD, // Use App Password for Gmail
      },
    });

    try {
      for (const to of EMAIL_RECIPIENTS) {
        await transporter.sendMail({
          from: GMAIL_USER,
          to,
          subject: `Ticket Alert: ${matchName}`,
          text: message,
        });
        console.log(`📨 Email sent to ${to}`);
      }
      return `Emails sent successfully to ${EMAIL_RECIPIENTS.length} recipients!`;
    } catch (error) {
      console.error("❌ Email sending failed:", error.message);
      return `Failed to send emails: ${error.message}`;
    }
  }
);

const ticketAnalysisPrompt = ai.definePrompt(
  {
    name: "ticketAnalysisPrompt",
    tools: [sendEmailTool],
  },
  `You are a ticket availability checker for Royal Challengers Bangalore cricket matches.
  Your target match is: May 03, 2025 07:30 PM Royal Challengers Bengaluru VS Chennai Super Kings

  I will give you scraped content from the RCB ticket website. You need to accurately determine ONLY if tickets for the specified target match are available for purchase.

  Scraped content:
  """
  {{scrapedContent}}
  """

  IMPORTANT INSTRUCTIONS:
  1. Carefully locate the exact entry for "May 03, 2025 07:30 PM Royal Challengers Bengaluru VS Chennai Super Kings".
  2. Examine the text *immediately following* this match entry.
  3. Tickets are AVAILABLE ONLY IF you find both a price range (like "Rs [...]") AND the text "BUY TICKETS" associated *specifically* with "May 03, 2025 07:30 PM Royal Challengers Bengaluru VS Chennai Super Kings
  4. If May 03, 2025 07:30 PM Royal Challengers Bengaluru VS Chennai Super Kings}" is followed by "SOLD OUT", "PHASE 1 SOLD OUT", "COMING SOON", or lacks both a price and "BUY TICKETS", then tickets are NOT available.
  5. Critically, DO NOT confuse the status of "May 03, 2025 07:30 PM Royal Challengers Bengaluru VS Chennai Super Kings with any other match listed. Verify the status belongs strictly to May 03, 2025 07:30 PM Royal Challengers Bengaluru VS Chennai Super Kings".
  6. Pay special attention to verify the exact date for RCB vs CSK (May 03, 2025) to ensure you're checking the correct match.

  RESPONSE ACTIONS:

  A) IF AND ONLY IF tickets for "May 03, 2025 07:30 PM Royal Challengers Bengaluru VS Chennai Super Kings" are confirmed available (price + "BUY TICKETS"):
     - Use the "sendEmailTool".
     - The tool 'matchName' input MUST be exactly "{{targetMatch}}".
     - The tool 'message' input should be: "Good news! Tickets for May 03, 2025 07:30 PM Royal Challengers Bengaluru VS Chennai Super Kings appear to be available NOW. Price range likely indicates availability. Book quickly at the official RCB ticket website."
     - After successfully using the tool, your *final text response* MUST be: "EMAIL_SENT: Tickets found for {{targetMatch}} and notification sent."

  B) If tickets for "May 03, 2025 07:30 PM Royal Challengers Bengaluru VS Chennai Super Kings" are NOT available (e.g., "SOLD OUT", "PHASE 1 SOLD OUT") OR the status is unclear or cannot be reliably determined from the text:
     - Do NOT use the "sendEmailTool".
     - Your *final text response* MUST be: "NOT_AVAILABLE: No tickets currently available for {{targetMatch}}."

  Provide ONLY the final text response ("EMAIL_SENT: ..." or "NOT_AVAILABLE: ...") based on your analysis and actions.
  `
);

// --- Core Functions ---

// Function to scrape ticket website content
async function scrapeTicketWebsite() {
  console.log("🔍 Starting website scraping...");
  let browser;
  try {
    browser = await puppeteer.launch({ headless: true }); // Use true for headless
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36"
    ); // Set a user agent

    console.log(`Navigating to ${RCB_TICKET_URL}...`);
    await page.goto(RCB_TICKET_URL, {
      waitUntil: "networkidle2",
      timeout: 60000,
    }); // Increased timeout

    // Optional: Wait for a specific element that indicates content is loaded
    // await page.waitForSelector('.match-container', { timeout: 10000 });

    console.log("Extracting page content...");
    const textContent = await page.evaluate(() => document.body.innerText);
    const cleanedText = textContent.replace(/\s+/g, " ").trim(); // Clean whitespace
    console.log("✅ Website scraped successfully");
    return cleanedText;
  } catch (error) {
    console.error(`❌ Scraping failed: ${error.message}`);
    return null;
  } finally {
    if (browser) {
      await browser.close();
      console.log("Browser closed.");
    }
  }
}

// Function to analyze ticket data via LLM and send emails if tickets available
async function analyzeAndNotify(scrapedData, targetMatch) {
  console.log("🧠 Processing scraped ticket data...");
  if (!scrapedData) {
    console.error("❌ Cannot analyze data, scraping failed.");
    return "Error: Scraping failed previously.";
  }
  console.log(scrapedData);

  try {
    // Run the analysis prompt with the scraped data and target match
    const result = await ticketAnalysisPrompt({
      scrapedContent: scrapedData,
      targetMatch: targetMatch,
    });

    // *** FIX: Get the text response using .text() ***
    const analysisResultText = await result.message.content;

    console.log("✅ Ticket analysis completed:", analysisResultText);
    return analysisResultText; // Return the final text status ("EMAIL_SENT:..." or "NOT_AVAILABLE:...")
  } catch (error) {
    // Log the full error if needed for debugging Genkit/API issues
    // console.error("❌ Full error during ticket analysis:", error);
    console.error("❌ Error analyzing tickets:", error.message);
    return `Error analyzing tickets: ${error.message}`;
  }
}

// Main function to check and notify about ticket availability
async function checkAndNotifyTickets() {
  console.log(`🎟️ Starting check for ${TARGET_MATCH} tickets...`);

  try {
    // Step 1: Scrape the website
    const scrapedData = await scrapeTicketWebsite();

    // Log scraped data only if needed for debugging, can be very long
    // console.log("Scraped Data:", scrapedData ? scrapedData.substring(0, 500) + "..." : "None");

    if (!scrapedData) {
      console.error("❌ Failed to retrieve website data. Skipping analysis.");
      return "Scraping failed. Will try again later.";
    }

    // Step 2: Analyze data and trigger notifications if needed
    const analysisStatus = await analyzeAndNotify(scrapedData, TARGET_MATCH);
    console.log(`📊 Analysis Status: ${analysisStatus}`);
    // The analysisStatus variable now holds the final message from the LLM
    return analysisStatus;
  } catch (error) {
    console.error("❌ Error in check and notify process:", error.message);
    return `Error checking tickets: ${error.message}`;
  }
}

// --- Main Execution Logic ---

console.log("🚀 Ticket monitoring service started!");
console.log(
  `🕒 Checking for ${TARGET_MATCH} tickets every ${
    CRON_SCHEDULE.includes("*/")
      ? CRON_SCHEDULE.split("/")[1].split(" ")[0]
      : "specified interval"
  } minutes...`
);
console.log(`📧 Notifications will be sent to: ${EMAIL_RECIPIENTS.join(", ")}`);
console.log("🔑 Using Gmail user:", GMAIL_USER); // Be careful logging this if sensitive

// Cron job to run on the defined schedule
cron.schedule(CRON_SCHEDULE, async () => {
  const timestamp = new Date().toISOString();
  console.log(`\n🕒 [${timestamp}] Running scheduled ticket check...`);
  const result = await checkAndNotifyTickets();
  console.log(`🏁 [${timestamp}] Scheduled check finished. Result: ${result}`);
});

// Run it once immediately on startup
(async () => {
  console.log("\n🔍 Running initial ticket check...");
  const initialResult = await checkAndNotifyTickets();
  console.log(`🏁 Initial check finished. Result: ${initialResult}`);
  console.log("\n Maintating watch using cronjob... ");
})();
