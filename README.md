Absolutely! To create a high-quality README for the prs-helper-bot, I'll first need to analyze the codebase to understand its features, usage, setup, and purpose. I'll start by searching for the project's entry points and main files, such as app.js, index.js, main.py, README.md (if any), package.json, or other key files that can reveal the project's structure and functionality.

Let me begin by searching for common entry files and configuration files in the root of your repository.````markdown name=README.md
# PRS Helper Bot

**PRS Helper Bot** is a feature-rich Discord bot for managing Google Form responses, creating and managing receipts, ticketing, and utility workflows for car dealerships or sales teams. It is designed to streamline operations by integrating Google Sheets, Discord, and MongoDB.

---

## Features

- **Google Form Tracking**: Automatically posts new Google Form responses to designated Discord channels.
- **Receipt Generation**: Create booking and sales receipts directly from Discord slash commands.
- **Ticketing System**: Create, close, and delete support tickets with category configuration.
- **Permission Management**: Fine-grained permission system for managing who can use specific commands.
- **Utility Commands**: Direct messaging, maintenance mode, fun commands like random cats, and more.

---

## Commands

Below are all available slash commands. Use `/help` in Discord for detailed usage.

| Command | Description |
|---------|-------------|
| `/addform` | Start tracking a Google Form. |
| `/removeform [sheetname]` | Stop tracking a Google Form. |
| `/listforms` | List all tracked forms. |
| `/checkupdates` | Manually check for unsent form responses. |
| `/booking [buyer_name] [mobile] [model] [license] [total] [booking_amount]` | Create a car booking receipt. |
| `/sell [buyer_name] [buyer_cid] [buyer_number] [model] [license] [price] [discount]` | Create a vehicle purchase receipt. |
| `/newsell [type] [name] [contact] [cid] [dmail] [vehicle] [license] [amount] [transferred_to]` | Create a vehicle intake or acquisition receipt. |
| `/dm [user] [text]` | Send a DM through the bot (requires permission). |
| `/cats` | Shows random cat pictures. |
| `/ping` | Check bot latency and API status. |
| `/giveperms [user] [permission]` | Grant permissions to a user (admin only). |
| `/revokeperms [user] [permission]` | Revoke permissions from a user (admin only). |
| `/checkperms [user]` | Check a user's permissions. |
| `/maintenancelb [time]` | Put the site in maintenance mode for a specified duration. |
| `/forcemaintenanceoff` | Force turn off maintenance mode. |
| `/setticketcategory [category]` | Set the category where tickets will be created. |
| `/closeticket` | Close the current ticket channel. |
| `/deleteticket` | Delete the current ticket channel. |
| `/say [channel] [text]` | Send a normal message to a specified channel. |
| `/help` | Show this help message. |

---

## Requirements

- Node.js v16.11.0 or higher
- MongoDB
- Google Service Account (for Google Sheets API)
- Discord Bot Token

### Environment Variables

Create a `.env` file in your project root containing:

```
DISCORD_TOKEN=your_discord_bot_token
GOOGLE_SERVICE_ACCOUNT_JSON={"type":...}     # Paste your Google Service Account JSON here
MONGO_URI=your_mongodb_connection_uri
```

These are **required**. The bot will not start if any are missing.

---

## Setup & Running Locally

1. **Clone the repository:**
   ```sh
   git clone https://github.com/Kishanx08/prs-helper-bot.git
   cd prs-helper-bot
   ```

2. **Install dependencies:**
   ```sh
   npm install
   ```

3. **Configure your `.env` file:**  
   See [Requirements](#requirements).

4. **Start the bot:**
   ```sh
   node bot.js
   ```

5. **Invite the bot to your Discord server** with the required permissions.

---

## How It Works

- **Google Form Integration:**  
  The bot uses a Google Service Account to read responses from specified Google Sheets. When new responses are detected, it posts them as embeds in your configured Discord channels.

- **Receipt & Ticket System:**  
  Staff can create receipts for bookings and sales, and manage support tickets. Tickets are tracked in MongoDB and can be closed or deleted by staff/admins.

- **Permissions:**  
  Only users with the correct bot-granted permissions (managed by `/giveperms` and `/revokeperms`) can use sensitive commands (like adding/removing forms, sending DMs, etc.). Admins always have full access.

---

## Example: Tracking a Google Form

1. Use `/addform` to start setup.
2. The bot will prompt you to select a spreadsheet and a channel.
3. New responses from that form will be posted to the chosen channel.

---

## Example: Creating a Receipt

- Use `/booking` or `/sell` with all required fields.  
- The bot will generate a styled receipt embed and post it in the configured channel.

---

## Health Check Endpoint

If you deploy the bot to a service like Render.com, a minimal Express server runs at `/` to respond to health checks.

---

## License

MIT

---

## Credits

- Built using [discord.js](https://discord.js.org/), [googleapis](https://www.npmjs.com/package/googleapis), and [mongodb](https://mongodb.github.io/node-mongodb-native/).
- Random cat images powered by [TheCatAPI](https://thecatapi.com/).
````
