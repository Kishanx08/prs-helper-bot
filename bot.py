import discord
import gspread
import asyncio
import os
from oauth2client.service_account import ServiceAccountCredentials

# Load credentials from JSON file
creds = ServiceAccountCredentials.from_json_keyfile_name(
    "prs-helper-e3c6b24e9d53.json",
    ["https://www.googleapis.com/auth/spreadsheets", "https://www.googleapis.com/auth/drive"]
)
client_gspread = gspread.authorize(creds)

# Open your Google Sheet
SHEET_NAME = "testing"
worksheet = client_gspread.open(SHEET_NAME).sheet1

# Discord Bot Setup
TOKEN = os.getenv("DISCORD_BOT_TOKEN")  # Fetch token from Replit secrets
CHANNEL_ID = 1202157205839953962  # Replace with your Discord channel ID

intents = discord.Intents.default()
client = discord.Client(intents=intents)

async def check_new_responses():
    last_row = 0
    await client.wait_until_ready()
    channel = client.get_channel(CHANNEL_ID)

    while not client.is_closed():
        rows = worksheet.get_all_values()
        if len(rows) > last_row:
            new_data = rows[last_row:]
            last_row = len(rows)
            
            for row in new_data:
                embed = discord.Embed(
                    title="📝 New Google Form Response",
                    color=discord.Color.blue()
                )
                for i in range(len(row)):
                    embed.add_field(name=f"**{worksheet.row_values(1)[i]}**", value=row[i], inline=False)

                embed.set_footer(text="Google Form Auto-Response Bot")
                await channel.send(embed=embed)

        await asyncio.sleep(10)  # Check every 10 seconds

@client.event
async def on_ready():
    print(f'✅ Logged in as {client.user}')
    client.loop.create_task(check_new_responses())

client.run(TOKEN)
