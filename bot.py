import discord
import gspread
import asyncio
import os
import json
import threading
from flask import Flask
from discord.ext import commands
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
client_gspread = gspread.authorize(creds)  # Initialize client_gspread

# Discord Bot Setup
TOKEN = os.getenv("DISCORD_TOKEN")  # Ensure the correct env variable name

if TOKEN is None:
    raise ValueError("DISCORD_TOKEN is not set!")

intents = discord.Intents.default()
intents.message_content = True  # Enable message content intent
bot = commands.Bot(command_prefix="!", intents=intents)

form_channels = {}

def load_last_row(sheet_name):
    try:
        with open(f'{sheet_name}_last_row.json', 'r') as f:
            return json.load(f).get('last_row', 1)
    except FileNotFoundError:
        return 1

def save_last_row(sheet_name, last_row):
    with open(f'{sheet_name}_last_row.json', 'w') as f:
        json.dump({'last_row': last_row}, f)

async def check_new_responses(sheet_name, channel_id):
    worksheet = client_gspread.open(sheet_name).sheet1
    last_row = load_last_row(sheet_name)  # Load last_row from file
    await bot.wait_until_ready()
    channel = bot.get_channel(channel_id)

    while not bot.is_closed():
        rows = worksheet.get_all_values()
        if len(rows) > last_row:
            new_data = rows[last_row:]  # Get new rows
            last_row = len(rows)  # Update last seen row
            save_last_row(sheet_name, last_row)  # Save last_row to file

            for row in new_data:
                embed = discord.Embed(
                    title="📝 New Google Form Response",
                    color=discord.Color.red()
                )

                headers = worksheet.row_values(1)  # Get column headers
                for i in range(len(row)):
                    embed.add_field(name=f"**{headers[i]}**", value=row[i] if row[i] else "N/A", inline=True)

                embed.set_footer(text="Google Form Auto-Response Bot")
                await channel.send(embed=embed)

        await asyncio.sleep(10)  # Check every 10 seconds

@bot.event
async def on_ready():
    print(f'✅ Logged in as {bot.user}')

@bot.command(name="add_form")
async def add_form(ctx, sheet_name: str, channel_id: int):
    if sheet_name in form_channels:
        await ctx.send(f"Form '{sheet_name}' is already being tracked.")
        return
    
    try:
        # Try to open the worksheet to check if it exists
        worksheet = client_gspread.open(sheet_name).sheet1
    except gspread.SpreadsheetNotFound:
        await ctx.send(f"Form '{sheet_name}' does not exist.")
        return
    except Exception as e:
        await ctx.send(f"An error occurred: {str(e)}")
        return
    
    form_channels[sheet_name] = channel_id
    bot.loop.create_task(check_new_responses(sheet_name, channel_id))
    await ctx.send(f"Started tracking form '{sheet_name}' in channel <#{channel_id}>.")

@bot.command(name="remove_form")
async def remove_form(ctx, sheet_name: str):
    if sheet_name not in form_channels:
        await ctx.send(f"Form '{sheet_name}' is not being tracked.")
        return
    del form_channels[sheet_name]
    await ctx.send(f"Stopped tracking form '{sheet_name}'.")

# Flask Web Server to Keep Replit Alive
app = Flask(__name__)

@app.route("/")
def home():
    return "✅ Bot is running!"

def run_web():
    app.run(host="0.0.0.0", port=5000)  # Use a different port if needed

# Run Flask server in a separate thread
threading.Thread(target=run_web, daemon=True).start()

# Move `bot.run(TOKEN)` to the end, after defining `bot`
bot.run(TOKEN)
