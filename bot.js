require('dotenv').config();
const { Client, GatewayIntentBits, EmbedBuilder, REST, Routes } = require('discord.js');
const { google } = require('googleapis');
const { MongoClient } = require('mongodb');
const express = require('express');
const { RateLimiter } = require('limiter');

// Error handling
process.on('unhandledRejection', (error) => {
  console.error('Unhandled Promise Rejection:', error);
});
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

// Rate limiter
const limiter = new RateLimiter({ tokensPerInterval: 50, interval: 'minute' });

// Slash commands
const commands = [
  { name: 'addform', description: 'Start tracking a Google Form' },
  { name: 'removeform', description: 'Stop tracking a Google Form', options: [{ name: 'sheetname', description: 'Name of the Google Sheet', type: 3, required: true }] },
  { name: 'listforms', description: 'List all tracked forms' },
  { name: 'ping', description: 'Check bot latency and API status' },
  { name: 'dm', description: 'Send a DM through the bot', options: [{ name: 'user', description: 'User to DM', type: 6, required: true }, { name: 'text', description: 'Message content', type: 3, required: true }] },
  { name: 'status', description: 'Change the bot status', options: [{ name: 'status', description: 'New status message', type: 3, required: true }, { name: 'type', description: 'Type of status (playing, streaming, listening, watching)', type: 3, required: false }] }
];

// Validate environment
const REQUIRED_ENV = ['DISCORD_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'MONGO_URI'];
REQUIRED_ENV.forEach(variable => {
  if (!process.env[variable]) throw new Error(`Missing ${variable} in .env`);
});

// Initialize Discord client
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

// Google Sheets setup
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets.readonly', 'https://www.googleapis.com/auth/drive.readonly'];
const serviceAccount = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);

// MongoDB setup
const mongoClient = new MongoClient(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
  retryWrites: true,
  retryReads: true
});

mongoClient.on('error', (err) => {
  console.error('MongoDB Error:', err);
});

let db, formChannelsCollection, lastRowsCollection;
let formChannels = new Map();
let interactionState = {};

function clearUserState(userId) {
  if (interactionState[userId]?.timeout) {
    clearTimeout(interactionState[userId].timeout);
  }
  delete interactionState[userId];
}

// Initialize database - UPDATED
async function initializeDatabase() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('prs-helper');
    
    formChannelsCollection = db.collection('form_channels');
    lastRowsCollection = db.collection('last_rows');
    
    const docs = await formChannelsCollection.find().toArray();
    formChannels = new Map();
    
    docs.forEach(doc => {
      if (!doc.spreadsheet_id || !doc.guild_id) {
        console.warn('Skipping invalid entry:', doc);
        return;
      }
      formChannels.set(`${doc.guild_id}:${doc.spreadsheet_id}`, {
        channelId: doc.channel_id,
        sheet_name: doc.sheet_name,
        guild_id: doc.guild_id,
        spreadsheet_id: doc.spreadsheet_id
      });
    });
    
    console.log(`✅ Initialized ${formChannels.size} valid form mappings`);
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
    process.exit(1);
  }
}

// Google auth
async function getAuthClient() {
  try {
    const auth = new google.auth.JWT({
      email: serviceAccount.client_email,
      key: serviceAccount.private_key.replace(/\\n/g, '\n'),
      scopes: SCOPES
    });
    await auth.authorize();
    return auth;
  } catch (error) {
    console.error('❌ Google auth failed:', error);
    throw error;
  }
}

// Fetch responses with rate limiting
async function fetchResponses(spreadsheetId, sheetName) {
  await limiter.removeTokens(1);
  try {
    const auth = await getAuthClient();
    const sheets = google.sheets({ version: 'v4', auth });

    const [headerResponse, dataResponse] = await Promise.all([
      sheets.spreadsheets.values.get({ spreadsheetId, range: `'${sheetName}'!1:1` }),
      sheets.spreadsheets.values.get({ spreadsheetId, range: `'${sheetName}'!A2:Z` })
    ]);

    return {
      headers: headerResponse.data.values?.[0] || [],
      values: dataResponse.data.values || []
    };
  } catch (error) {
    console.error(`❌ Failed to fetch ${sheetName}:`, error.message);
    return null;
  }
}

// Process spreadsheet with retries - UPDATED
async function processSpreadsheet(spreadsheetId, channelId, guildId, retries = 3) {
  if (!spreadsheetId) throw new Error('Missing spreadsheetId');
  if (!guildId) throw new Error('Missing guildId');

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const auth = await getAuthClient();
      const sheets = google.sheets({ version: 'v4', auth });
      const metadata = await sheets.spreadsheets.get({ spreadsheetId });
      const sheetNames = metadata.data.sheets.map(sheet => sheet.properties.title);

      for (const sheetName of sheetNames) {
        const response = await fetchResponses(spreadsheetId, sheetName);
        if (!response?.values) continue;

        const lastRowDoc = await lastRowsCollection.findOne({ 
          spreadsheet_id: spreadsheetId,
          sheet_name: sheetName,
          guild_id: guildId
        });
        const lastProcessedRow = lastRowDoc?.last_row || 0;

        if (response.values.length > lastProcessedRow) {
          const newResponses = response.values.slice(lastProcessedRow);
          await sendResponses(channelId, response.headers, newResponses, sheetName);
          
          await lastRowsCollection.updateOne(
            { 
              spreadsheet_id: spreadsheetId,
              sheet_name: sheetName,
              guild_id: guildId
            },
            { $set: { last_row: response.values.length } },
            { upsert: true }
          );
          console.log(`✅ Processed ${newResponses.length} new responses from ${sheetName}`);
        }
      }
      return;
    } catch (error) {
      console.error(`Attempt ${attempt} failed for ${spreadsheetId}:`, error.message);
      if (attempt === retries) throw error;
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// Send responses to Discord
async function sendResponses(channelId, headers, responses, sheetName) {
  const channel = client.channels.cache.get(channelId);
  if (!channel) {
    console.error(`❌ Channel ${channelId} not found`);
    return;
  }

  for (const response of responses) {
    try {
      const embed = new EmbedBuilder()
        .setTitle(`📝 New Response (${sheetName})`)
        .setColor(0x00FF00);

      response.forEach((value, index) => {
        const question = headers[index] || `Question ${index + 1}`;
        embed.addFields({
          name: question,
          value: value?.toString().substring(0, 1000) || 'No response',
          inline: false
        });
      });

      await channel.send({ embeds: [embed] });
    } catch (error) {
      console.error('❌ Failed to send response:', error);
    }
  }
}

// Poll all sheets in parallel - UPDATED
async function pollSheets() {
  // 1. Connection check
  if (!mongoClient.topology?.isConnected()) {
    console.log('⚠️ MongoDB disconnected, reconnecting...');
    try {
      await initializeDatabase();
    } catch (error) {
      console.error('❌ Failed to reconnect to MongoDB:', error);
      return;
    }
  }

  console.log('🔍 Polling sheets...');
  
  // 2. Convert formChannels to array FIRST
  const entriesArray = Array.from(formChannels.entries());
  console.log('Debug - formChannels entries:', entriesArray);

  if (entriesArray.length === 0) {
    console.log('ℹ️ No spreadsheets being tracked');
    return;
  }

  // 3. Create array of promises FIRST
  const pollingPromises = entriesArray.map(
    ([key, config]) => {
      return (async () => {
        try {
          if (!config.spreadsheet_id) {
            console.error('Invalid config for key', key, 'Full config:', config);
            throw new Error(`Missing spreadsheet_id in config`);
          }
          await processSpreadsheet(config.spreadsheet_id, config.channelId, config.guild_id);
        } catch (error) {
          console.error(`❌ Failed polling in guild ${config.guild_id}:`, error.message);
          // Auto-clean invalid entries
          formChannels.delete(key);
          await formChannelsCollection.deleteOne({
            guild_id: config.guild_id,
            spreadsheet_id: config.spreadsheet_id
          });
        }
      })();
    }
  );

  // 4. Then pass to Promise.allSettled
  await Promise.allSettled(pollingPromises);
  console.log('✅ Polling cycle completed');
}

// Discord bot setup
client.once('ready', async () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  await initializeDatabase();
  
  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ Slash commands registered');
  } catch (error) {
    console.error('❌ Failed to register commands:', error);
  }
  
  setInterval(pollSheets, 900000);
  console.log('✅ Bot operational');
});

// Slash command handlers
on('interactionCreate', async interaction => {
  if (!interaction || !interaction.guild?.id) {
    console.error('Invalid interaction received');
    return;
  }
  try {
    switch (interaction.commandName) {
      case 'status':
        const newStatus = interaction.options.getString('status');
        const statusType = interaction.options.getString('type') || 'playing';
        const validTypes = ['playing', 'streaming', 'listening', 'watching'];

        if (!validTypes.includes(statusType.toLowerCase())) {
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription('❌ Invalid status type. Valid types are: playing, streaming, listening, watching.')
                .setColor(0xFF0000)
            ],
            ephemeral: true
          });
          return;
        }

        const activities = {
          playing: { name: newStatus, type: 'PLAYING' },
          streaming: { name: newStatus, type: 'STREAMING', url: 'https://twitch.tv/yourstream' }, // Update with your stream URL
          listening: { name: newStatus, type: 'LISTENING' },
          watching: { name: newStatus, type: 'WATCHING' }
        };

        client.user.setPresence({ activities: [activities[statusType.toLowerCase()]] });
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setDescription(`✅ Status updated to: ${statusType.charAt(0).toUpperCase() + statusType.slice(1)} ${newStatus}`)
              .setColor(0x00FF00)
          ],
          ephemeral: true
        });
        break;

      case 'clearstatus':
        client.user.setPresence({ activities: [] });
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setDescription('✅ Status cleared')
              .setColor(0x00FF00)
          ],
          ephemeral: true
        });
        break;

      case 'addform':
        await handleAddForm(interaction);
        break;
      
      case 'removeform':
        const spreadsheetName = interaction.options.getString('sheetname');
        
        // Only look for forms in current server
        const entry = [...formChannels.entries()].find(
          ([_, config]) => config.sheet_name === spreadsheetName && 
          config.guild_id === interaction.guild.id
        );
        
        if (entry) {
          formChannels.delete(entry[0]);
          await formChannelsCollection.deleteOne({ 
            spreadsheet_id: entry[1].spreadsheet_id,
            guild_id: interaction.guild.id // Only delete from current server
          });
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription(`✅ Stopped tracking ${spreadsheetName}`)
                .setColor(0x00FF00)
            ]
          });
        } else {
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription('❌ Spreadsheet not being tracked in this server')
                .setColor(0xFF0000)
              ]
          });
        }
        break;

      case 'listforms':
        // Only show forms from current server
        const list = Array.from(formChannels)
          .filter(([_, config]) => config.guild_id === interaction.guild.id)
          .map(([_, { channelId, sheet_name }]) => 
            `- ${sheet_name} → <#${channelId}>`
          )
          .join('\n') || 'No tracked forms in this server';
        
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('📋 Tracked Forms')
              .setDescription(list)
              .setColor(0x00FF00)
          ]
        });
        break;

      case 'ping':
        const latency = Date.now() - interaction.createdTimestamp;
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setDescription(`🏓 Pong! Latency: ${latency}ms`)
              .setColor(0x00FF00)
          ]
        });
        break;

      case 'dm':
        // Permission check - replace with your user IDs
        const ALLOWED_USERS = ['1057573344855207966', '456103757676150784', '497307688221409280'];
        if (!ALLOWED_USERS.includes(interaction.user.id)) {
          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription('❌ You lack permissions for this')
                .setColor(0xFF0000)
            ],
            ephemeral: true
          });
        }

        const user = interaction.options.getUser('user');
        const text = interaction.options.getString('text');

        try {
          await user.send({
            embeds: [
              new EmbedBuilder()
                .setTitle(`📨 From ${interaction.user.tag}`)
                .setDescription(text)
                .setColor(0x00FF00)
            ]
          });
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription(`✅ DM sent to ${user.tag}`)
                .setColor(0x00FF00)
            ],
            ephemeral: true
          });
        } catch (error) {
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription(`❌ Failed to DM ${user.tag} (they may have DMs disabled)`)
                .setColor(0xFF0000)
            ],
            ephemeral: true
          });
        }
        break;

      default:
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setDescription('❌ Unknown command')
              .setColor(0xFF0000)
          ],
          ephemeral: true
        });
    }
  } catch (error) {
    console.error('❌ Interaction error:', error);
    if (!interaction.replied && !interaction.deferred) {
      await interaction.reply({
        embeds: [
          new EmbedBuilder()
            .setDescription('⚠️ An error occurred')
            .setColor(0xFF0000)
        ],
        ephemeral: true
      });
    }
  }
});

// Form setup flow
async function handleAddForm(interaction) {
  try {
    clearUserState(interaction.user.id);

    const auth = await getAuthClient();
    const drive = google.drive({ version: 'v3', auth });
    
    const { data } = await drive.files.list({
      q: "mimeType='application/vnd.google-apps.spreadsheet'",
      fields: 'files(id, name)',
    });

    interactionState[interaction.user.id] = {
      step: 'selectSpreadsheet',
      spreadsheets: data.files,
      timeout: setTimeout(() => {
        clearUserState(interaction.user.id);
        interaction.followUp({
          embeds: [
            new EmbedBuilder()
              .setDescription('⌛ Timed out! Use `/addform` again to restart')
              .setColor(0xFFA500)
          ],
          ephemeral: true
        });
      }, 15000) // 15-second timeout
    };

    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setTitle('📂 Available Spreadsheets')
          .setDescription(data.files.map(f => `- ${f.name}`).join('\n'))
          .setFooter({ text: '⏳ Reply with the exact name within 15 seconds' })
          .setColor(0x00FF00)
      ],
      ephemeral: true
    });
  } catch (error) {
    console.error('❌ Addform error:', error);
    clearUserState(interaction.user.id);
    await interaction.reply({
      embeds: [
        new EmbedBuilder()
          .setDescription('⚠️ Failed to fetch spreadsheets')
          .setColor(0xFF0000)
      ]
    });
  }
}

// Message handling for form setup
client.on('messageCreate', async message => {
  if (message.author.bot) return;

  const userId = message.author.id;
  const state = interactionState[userId];
  if (!state) return;

  try {
    // Clear the previous timeout
    clearTimeout(state.timeout);

    if (state.step === 'selectSpreadsheet') {
      const spreadsheet = state.spreadsheets.find(f => f.name === message.content.trim());
      if (!spreadsheet) {
        throw new Error('Invalid spreadsheet name');
      }

      state.spreadsheet = spreadsheet;
      state.step = 'selectChannel';
      state.timeout = setTimeout(() => {
        clearUserState(userId);
        message.reply({
          embeds: [
            new EmbedBuilder()
              .setDescription('⌛ Channel selection timed out! Use `/addform` to restart')
              .setColor(0xFFA500)
          ]
        });
      }, 15000);

      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setDescription('Mention the channel to receive responses:')
            .setFooter({ text: '⏳ Mention a channel within 15 seconds' })
            .setColor(0x00FF00)
        ]
      });
    }
    else if (state.step === 'selectChannel') {
      const channelId = message.mentions.channels.first()?.id;
      if (!channelId) {
        throw new Error('No channel mentioned');
      }

      // Store with guild ID
  formChannels.set(`${message.guild.id}:${state.spreadsheet.id}`, {
    channelId,
    sheet_name: state.spreadsheet.name,
    guild_id: message.guild.id // Add guild ID
  });

      // Save to database with guild ID
  await formChannelsCollection.insertOne({
    sheet_name: state.spreadsheet.name,
    channel_id: channelId,
    spreadsheet_id: state.spreadsheet.id,
    guild_id: message.guild.id // Add guild ID
  });

      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setDescription(`✅ Now tracking ${state.spreadsheet.name} in <#${channelId}>`)
            .setColor(0x00FF00)
        ]
      });
      clearUserState(userId);
    }
  } catch (error) {
    clearUserState(userId);
    await message.reply({
      embeds: [
        new EmbedBuilder()
          .setDescription(`❌ ${error.message}. Use \`/addform\` to restart`)
          .setColor(0xFF0000)
      ]
    });
  }
});

// Web server
const app = express();
app.get('/', (req, res) => res.send('🟢 Bot Online'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌐 Web server listening on port ${PORT}`));

// Graceful shutdown
process.on('SIGINT', async () => {
  await mongoClient.close();
  client.destroy();
  process.exit(0);
});

// Start bot
client.login(process.env.DISCORD_TOKEN);