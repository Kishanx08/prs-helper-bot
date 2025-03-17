import discord
import gspread
import asyncio
import os
import json
import threading
from flask import Flask
from google.oauth2.service_account import Credentials

# Load credentials from Replit Secrets
creds_json = os.getenv("GOOGLE_SERVICE_ACCOUNT_JSON")
if not creds_json:
    raise ValueError("🚨 Google Service Account JSON is missing! Add it in Replit Secrets.")

creds_dict = json.loads(creds_json)

# Authenticate with Google Sheets
scopes = [
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/spreadsheets.readonly",
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.file"
]

creds = Credentials.from_service_account_info(creds_dict, scopes=scopes)
client_gspread = gspread.authorize(creds)  # ✅ This line initializes client_gspread properly

# Open your Google Sheet
SHEET_NAME = "testing"
worksheet = client_gspread.open(SHEET_NAME).sheet1  # ✅ This should work now

# Discord Bot Setup
TOKEN = os.getenv("DISCORD_BOT_TOKEN")  # Fetch token from Replit secrets
CHANNEL_ID = 1202157205839953962  # Replace with your Discord channel ID

intents = discord.Intents.default()
client = discord.Client(intents=intents)

async def check_new_responses():
    last_row = 1  # Start from the first data row (header is row 0)
    await client.wait_until_ready()
    channel = client.get_channel(CHANNEL_ID)

    while not client.is_closed():
        rows = worksheet.get_all_values()
        if len(rows) > last_row:
            new_data = rows[last_row:]  # Get new rows
            last_row = len(rows)  # Update last seen row

            for row in new_data:
                embed = discord.Embed(
                    title="📝 New Google Form Response",
                    color=discord.Color.blue()
                )

                headers = worksheet.row_values(1)  # Get column headers
                for i in range(len(row)):
                    embed.add_field(name=f"**{headers[i]}**", value=row[i] if row[i] else "N/A", inline=False)

                embed.set_footer(text="Google Form Auto-Response Bot")
                await channel.send(embed=embed)

        await asyncio.sleep(10)  # Check every 10 seconds

@client.event
async def on_ready():
    print(f'✅ Logged in as {client.user}')
    client.loop.create_task(check_new_responses())

# Flask Web Server to Keep Replit Alive
app = Flask(__name__)

@app.route("/")
def home():
    return "✅ Bot is running!"

def run_web():
    app.run(host="0.0.0.0", port=8080)

# Run Flask server in a separate thread
threading.Thread(target=run_web, daemon=True).start()

client.run(TOKEN)
