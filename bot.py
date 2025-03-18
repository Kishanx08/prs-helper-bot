import discord
import gspread
import asyncio
import os
import json
from pymongo import MongoClient
import threading
from flask import Flask
from discord.ext import commands
from google.oauth2.service_account import Credentials
from urllib.parse import quote_plus  # Import this for URL encoding

# Load credentials from environment variables 
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

# MongoDB Setup
MONGO_URI = os.getenv("MONGO_URI")

if MONGO_URI:
    try:
        # Split the URI into parts
        scheme, rest = MONGO_URI.split("://", 1)  # Split on the first occurrence of "://"
        userinfo, host_and_db = rest.split("@", 1)  # Split on the first occurrence of "@"
        username, password = userinfo.split(":", 1)  # Split on the first occurrence of ":"

        # Encode the username and password
        encoded_username = quote_plus(username)  # Encodes special characters like '-'
        encoded_password = quote_plus(password)  # Encodes special characters like '@'

        # Reconstruct the URI with encoded credentials
        encoded_userinfo = f"{encoded_username}:{encoded_password}"
        MONGO_URI = f"{scheme}://{encoded_userinfo}@{host_and_db}"

        print(f"Reconstructed MONGO_URI: {MONGO_URI}")  # Debugging
    except Exception as e:
        raise ValueError(f"Invalid MONGO_URI format: {e}")

# Connect to MongoDB
client = MongoClient(MONGO_URI)
db = client['prs-helpter']  # Corrected database name
form_channels_collection = db['form_channels']  # Collection name

# Load form_channels from MongoDB
def load_form_channels():
    form_channels = {}
    for document in form_channels_collection.find():
        form_channels[document['sheet_name']] = document['channel_id']
    print("✅ form_channels loaded from MongoDB:", form_channels)  # Debugging
    return form_channels

# Save form_channels to MongoDB
def save_form_channels(form_channels):
    form_channels_collection.delete_many({})  # Clear existing data
    for sheet_name, channel_id in form_channels.items():
        form_channels_collection.insert_one({'sheet_name': sheet_name, 'channel_id': channel_id})
    print("✅ form_channels saved to MongoDB:", form_channels)  # Debugging

form_channels = load_form_channels()

def load_last_row(sheet_name):
    last_row_document = db['last_rows'].find_one({'sheet_name': sheet_name})
    if last_row_document:
        last_row = last_row_document.get('last_row', 1)
        print(f"✅ {sheet_name} last_row loaded from MongoDB:", last_row)  # Debugging
        return last_row
    else:
        print(f"⚠️ {sheet_name} last_row not found, initializing to 1")  # Debugging
        return 1

def save_last_row(sheet_name, last_row):
    db['last_rows'].update_one(
        {'sheet_name': sheet_name},
        {'$set': {'last_row': last_row}},
        upsert=True
    )
    print(f"✅ {sheet_name} last_row saved to MongoDB:", {"last_row": last_row})  # Debugging

async def check_new_responses(sheet_name, channel_id):
    worksheet = client_gspread.open(sheet_name).sheet1
    last_row = load_last_row(sheet_name)  # Load last_row from MongoDB
    await bot.wait_until_ready()
    channel = bot.get_channel(channel_id)

    while not bot.is_closed():
        rows = worksheet.get_all_values()
        if len(rows) > last_row:
            new_data = rows[last_row:]  # Get new rows
            last_row = len(rows)  # Update last seen row
            save_last_row(sheet_name, last_row)  # Save last_row to MongoDB

            for row in new_data:
                embed = discord.Embed(
                    title="📝 New Google Form Response",
                    color=discord.Color.blue()  # Changed to blue color
                )

                headers = worksheet.row_values(1)  # Get column headers
                for i in range(len(row)):
                    embed.add_field(name=f"**{headers[i]}**", value=row[i] if row[i] else "N/A", inline=False)

                embed.set_footer(text="Google Form Auto-Response Bot")

                try:
                    await channel.send(embed=embed)
                    await asyncio.sleep(2)  # Wait 2 seconds before sending the next message
                except discord.errors.HTTPException as e:
                    if e.status == 429:
                        retry_after = e.retry_after if hasattr(e, 'retry_after') else 5
                        print(f"Rate limited: {e}. Retrying in {retry_after} seconds.")
                        await asyncio.sleep(retry_after)
                    else:
                        print(f"An error occurred: {e}")
                        await asyncio.sleep(5)

        await asyncio.sleep(60)  # Check every 1 minute

@bot.event
async def on_ready():
    print(f'✅ Logged in as {bot.user}')
    print(f'🔹 Registered commands: {list(bot.commands)}')  # Debugging

@bot.command(name="add_form")
async def add_form(ctx, sheet_name: str, channel_id: int):
    print(f"🔹 add_form called with sheet_name: {sheet_name}, channel_id: {channel_id}")  # Debugging
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
    print(f"🔹 form_channels updated: {form_channels}")  # Debugging
    save_form_channels(form_channels)
    bot.loop.create_task(check_new_responses(sheet_name, channel_id))
    await ctx.send(f"Started tracking form '{sheet_name}' in channel <#{channel_id}>.")

@bot.command(name="remove_form")
async def remove_form(ctx, sheet_name: str):
    print(f"🔹 remove_form called with sheet_name: {sheet_name}")  # Debugging
    if sheet_name not in form_channels:
        await ctx.send(f"Form '{sheet_name}' is not being tracked.")
        return
    del form_channels[sheet_name]
    print(f"🔹 form_channels updated: {form_channels}")  # Debugging
    save_form_channels(form_channels)
    await ctx.send(f"Stopped tracking form '{sheet_name}'.")

@bot.command(name="list_forms")
async def list_forms(ctx):
    print("🔹 list_forms called")  # Debugging
    if not form_channels:
        await ctx.send("No forms are currently being tracked.")
        return

    embed = discord.Embed(
        title="📋 Tracked Forms",
        color=discord.Color.blue()
    )

    for sheet_name, channel_id in form_channels.items():
        channel = bot.get_channel(channel_id)
        channel_mention = channel.mention if channel else f"Channel ID: {channel_id}"
        embed.add_field(name=sheet_name, value=channel_mention, inline=False)

    await ctx.send(embed=embed)
    print("🔹 Sent tracked forms list")  # Debugging

@bot.command(name="ping")
async def ping(ctx):
    await ctx.send("Pong! 🏓")

# Flask Web Server to Keep the Bot Alive on Render
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
