require('dotenv').config();
const { Client, GatewayIntentBits, Partials, EmbedBuilder, REST, Routes } = require('discord.js');
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
  { 
    name: 'addform', 
    description: 'Start tracking a Google Form' 
  },
  { 
    name: 'removeform', 
    description: 'Stop tracking a Google Form', 
    options: [
      { 
        name: 'sheetname', 
        description: 'Name of the Google Sheet', 
        type: 3, 
        required: true 
      }
    ] 
  },
  { 
    name: 'listforms', 
    description: 'List all tracked forms' 
  },
  { 
    name: 'ping', 
    description: 'Check bot latency and API status' 
  },
  { 
    name: 'dm', 
    description: 'Send a DM through the bot', 
    options: [
      { 
        name: 'user', 
        description: 'User to DM', 
        type: 6, 
        required: true 
      }, 
      { 
        name: 'text', 
        description: 'Message content', 
        type: 3, 
        required: true 
      }
    ] 
  },
  { 
    name: 'checkupdates', 
    description: 'Manually check for any unsent form responses'
  },
  //  permission commands
  { 
    name: 'giveperms', 
    description: 'Grant permissions to a user',
    options: [
      { 
        name: 'user', 
        description: 'User to grant permissions to', 
        type: 6, 
        required: true 
      },
      { 
        name: 'permission', 
        description: 'Permission to grant', 
        type: 3, 
        required: true,
        choices: [
          { name: 'Manage Forms (add/remove/list)', value: 'manage_forms' },
          { name: 'Send DMs through bot', value: 'send_dms' }
        ]
      }
    ]
  },
  { 
    name: 'revokeperms', 
    description: 'Revoke permissions from a user',
    options: [
      { 
        name: 'user', 
        description: 'User to revoke permissions from', 
        type: 6, 
        required: true 
      },
      { 
        name: 'permission', 
        description: 'Permission to revoke', 
        type: 3, 
        required: true,
        choices: [
          { name: 'Manage Forms (add/remove/list)', value: 'manage_forms' },
          { name: 'Send DMs through bot', value: 'send_dms' }
        ]
      }
    ]
  },
  { 
    name: 'checkperms', 
    description: 'Check a user\'s permissions',
    options: [
      { 
        name: 'user', 
        description: 'User to check (leave empty for yourself)', 
        type: 6, 
        required: false 
      }
    ]
  },
  {
    name: 'setticketcategory',
    description: 'Set the category where tickets will be created',
    options: [{
      name: 'category',
      description: 'The category ID where tickets will be created',
      type: 3, // STRING type
      required: true
    }]
  },
  {
    name: 'closeticket',
    description: 'Close the current ticket channel',
  },
  {
    name: 'deleteticket',
    description: 'Delete the current ticket channel'
  }
];

// Validate environment
const REQUIRED_ENV = ['DISCORD_TOKEN', 'GOOGLE_SERVICE_ACCOUNT_JSON', 'MONGO_URI'];
REQUIRED_ENV.forEach(variable => {
  if (!process.env[variable]) throw new Error(`Missing ${variable} in .env`);
});

// Initialize Discord client
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.DirectMessageTyping,
    GatewayIntentBits.DirectMessageReactions,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildPresences,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildIntegrations
  ],
  partials: [
    Partials.Channel,
    Partials.Message,
    Partials.User,
    Partials.GuildMember,
    Partials.Reaction
  ]
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
let permissionsCollection;
let ticketSettingsCollection;
let activeTicketsCollection;
let interactionState = {};

function clearUserState(userId) {
  if (interactionState[userId]?.timeout) {
    clearTimeout(interactionState[userId].timeout);
  }
  delete interactionState[userId];
}

// Initialize database 
async function initializeDatabase() {
  try {
    await mongoClient.connect();
    db = mongoClient.db('prs-helper');
      formChannelsCollection = db.collection('form_channels');
    lastRowsCollection = db.collection('last_rows');
    permissionsCollection = db.collection('permissions');
    ticketSettingsCollection = db.collection('ticket_settings');
    activeTicketsCollection = db.collection('active_tickets');

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

// function to check permissions
async function hasPermission(userId, guildId, permission) {
  // Check if user has the specific permission
  const permissionDoc = await permissionsCollection.findOne({
    user_id: userId,
    guild_id: guildId,
    permission: permission
  });
  
  return !!permissionDoc;
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
  console.log('Intents:', client.options.intents);
  
  try {
    await initializeDatabase();
    console.log('✅ Database collections initialized:');
    console.log('- formChannelsCollection');
    console.log('- lastRowsCollection');
    console.log('- permissionsCollection');
    console.log('- ticketSettingsCollection');
    console.log('- activeTicketsCollection');
    
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    try {
      await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
      console.log('✅ Slash commands registered');
    } catch (error) {
      console.error('❌ Failed to register commands:', error);
    }
    
    setInterval(pollSheets, 900000);
    console.log('✅ Bot operational');
  } catch (error) {
    console.error('❌ Startup error:', error);
  }
});

// Slash command handlers
client.on('interactionCreate', async interaction => {
  if (!interaction || !interaction.guild?.id) {
    console.error('Invalid interaction received');
    return;
  }
  try {
    switch (interaction.commandName) {
      case 'addform':
      case 'removeform':
      case 'listforms':
        // Permission check for all form-related commands
        if (!await hasPermission(interaction.user.id, interaction.guild.id, 'manage_forms')) {
          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription('❌ You need "manage_forms" permission to use this command')
                .setColor(0xFF0000)
            ],
            ephemeral: true
          });
        }

        // Now handle each specific command
        if (interaction.commandName === 'addform') {
          await handleAddForm(interaction);
          break;
        }
        
        if (interaction.commandName === 'removeform') {
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
              guild_id: interaction.guild.id
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
        }

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
          ],
          ephemeral: true  // This makes the message only visible to the command user
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
        // Permission check - must come FIRST
        if (!await hasPermission(interaction.user.id, interaction.guild.id, 'send_dms')) {
          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription('❌ You need "send_dms" permission to use this command')
                .setColor(0xFF0000)
            ],
            ephemeral: true
          });
        }
  
        // Original DM command handling
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
       
      case 'checkupdates':
        try {
          // Acknowledge the interaction immediately since polling might take time
          await interaction.deferReply({ ephemeral: true });
            
          // Run the polling function
          await pollSheets();
            
          // Get all forms in the current guild
          const guildForms = Array.from(formChannels.values())
            .filter(config => config.guild_id === interaction.guild.id);
            
          if (guildForms.length === 0) {
            await interaction.editReply({
              embeds: [
                new EmbedBuilder()
                  .setDescription('ℹ️ No forms are being tracked in this server')
                  .setColor(0xFFFF00)
              ]
            });
            return;
          }
            
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setDescription('✅ Successfully checked for updates on all tracked forms')
                .setColor(0x00FF00)
                .addFields(
                  guildForms.map(form => ({
                    name: form.sheet_name,
                    value: `Posting to: <#${form.channelId}>`,
                    inline: true
                  }))
                )
            ]
          });

        } catch (error) {
            console.error('Checkupdates error:', error);
            await interaction.editReply({
              embeds: [
                new EmbedBuilder()
                  .setDescription('❌ Failed to check for updates')
                  .setColor(0xFF0000)
              ]
            });
          }
          break;

      case 'giveperms':
          const userToPermit = interaction.options.getUser('user');
          const permissionToGrant = interaction.options.getString('permission');

          await permissionsCollection.updateOne(
            {
              user_id: userToPermit.id,
              guild_id: interaction.guild.id,
              permission: permissionToGrant
            },
            { $set: { 
              user_id: userToPermit.id,
              guild_id: interaction.guild.id,
              permission: permissionToGrant,
              granted_by: interaction.user.id,
              granted_at: new Date()
            }},
            { upsert: true }
          );

          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription(`✅ Granted ${permissionToGrant} permission to ${userToPermit.tag}`)
                .setColor(0x00FF00)
            ],
            ephemeral: true
          });
          break;

      case 'revokeperms':
          const userToRevoke = interaction.options.getUser('user');
          const permissionToRevoke = interaction.options.getString('permission');

          const result = await permissionsCollection.deleteOne({
            user_id: userToRevoke.id,
            guild_id: interaction.guild.id,
            permission: permissionToRevoke
          });

          if (result.deletedCount > 0) {
            await interaction.reply({
              embeds: [
                new EmbedBuilder()
                  .setDescription(`✅ Revoked ${permissionToRevoke} permission from ${userToRevoke.tag}`)
                  .setColor(0x00FF00)
              ],
              ephemeral: true
            });
          } else {
            await interaction.reply({
              embeds: [
                new EmbedBuilder()
                  .setDescription(`ℹ️ ${userToRevoke.tag} didn't have ${permissionToRevoke} permission`)
                  .setColor(0xFFFF00)
              ],
              ephemeral: true
            });
          }
          break;

      case 'checkperms':
          const targetUser = interaction.options.getUser('user') || interaction.user;
          const userPermissions = await permissionsCollection.find({
            user_id: targetUser.id,
            guild_id: interaction.guild.id
          }).toArray();

          const permissionList = userPermissions.length > 0 
             ? userPermissions.map(p => `• ${p.permission}`).join('\n')
             : 'No special permissions';

             await interaction.reply({
              embeds: [
                new EmbedBuilder()
                  .setTitle(`🔐 Permissions for ${targetUser.tag}`)
                  .setDescription(permissionList)
                  .setColor(0x00FFFF)
                  .setFooter({ text: 'Administrators have all permissions by default' })
              ],
              ephemeral: true
            });
            break;      case 'setticketcategory':
        // Check for administrator permissions
        if (!interaction.member.permissions.has('Administrator')) {
          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription('❌ You need Administrator permission to use this command')
                .setColor(0xFF0000)
            ],
            ephemeral: true
          });
        }
        
        const categoryId = interaction.options.getString('category');
        await ticketSettingsCollection.updateOne(
          { guild_id: interaction.guild.id },
          { $set: { ticket_category: categoryId } },
          { upsert: true }
        );
        
        await interaction.reply({
          embeds: [
            new EmbedBuilder()
              .setTitle('🎟️ Ticket System')
              .setDescription('Ticket category has been set!')
              .addFields({ name: 'Category', value: `<#${categoryId}>` })
              .setColor(0x00FF00)
          ],
          ephemeral: true
        });
        break;      case 'closeticket':
        try {
          // Check for staff role or administrator permission
          if (!interaction.member.permissions.has('Administrator') && !interaction.member.permissions.has('ManageChannels')) {
            return interaction.reply({
              embeds: [
                new EmbedBuilder()
                  .setDescription('❌ You need staff permissions to close tickets')
                  .setColor(0xFF0000)
              ],
              ephemeral: true
            });
          }

          if (!interaction.channel.name.startsWith('ticket-')) {
            return interaction.reply({
              embeds: [
                new EmbedBuilder()
                  .setDescription('❌ This is not a ticket channel')
                  .setColor(0xFF0000)
              ],
              ephemeral: true
            });
          }

          const ticketData = await activeTicketsCollection.findOne({ 
            channel_id: interaction.channel.id,
            status: 'open'
          });

          if (!ticketData) {
            return interaction.reply({
              embeds: [
                new EmbedBuilder()
                  .setDescription('❌ Could not find ticket data')
                  .setColor(0xFF0000)
              ],
              ephemeral: true
            });
          }

          // Acknowledge the interaction first
          await interaction.deferReply();

          // Update ticket status first
          await activeTicketsCollection.updateOne(
            { channel_id: interaction.channel.id },
            { $set: { status: 'closed' } }
          );

          // Notify user
          const user = await client.users.fetch(ticketData.user_id);
          await user.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('🎟️ Ticket Closed')
                .setDescription('Your ticket has been closed by staff.')
                .setColor(0xFFA500)
                .setTimestamp()
            ]
          }).catch(() => console.log('Could not DM user about ticket closure'));

          // Edit the initial reply
          await interaction.editReply({
            embeds: [
              new EmbedBuilder()
                .setDescription('✅ Ticket closed - Channel will be deleted in 5 seconds')
                .setColor(0x00FF00)
            ]
          });

          // Delete channel after 5 seconds
          setTimeout(() => interaction.channel.delete().catch(console.error), 5000);

        } catch (error) {
          console.error('Error closing ticket:', error);
          const errorMessage = {
            embeds: [
              new EmbedBuilder()
                .setDescription('❌ Failed to close ticket')
                .setColor(0xFF0000)
            ],
            ephemeral: true
          };
          
          if (interaction.deferred) {
            await interaction.editReply(errorMessage);
          } else {
            await interaction.reply(errorMessage);
          }
        }
        break;case 'deleteticket':
        // Check for staff role or administrator permission
        if (!interaction.member.permissions.has('Administrator') && !interaction.member.permissions.has('ManageChannels')) {
          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription('❌ You need staff permissions to delete tickets')
                .setColor(0xFF0000)
            ],
            ephemeral: true
          });
        }
        
        if (!interaction.channel.name.startsWith('ticket-')) {
          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription('❌ This is not a ticket channel')
                .setColor(0xFF0000)
            ],
            ephemeral: true
          });
        }

        const ticketToDelete = await activeTicketsCollection.findOne({
          channel_id: interaction.channel.id
        });

        if (!ticketToDelete) {
          return interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription('❌ Could not find ticket data')
                .setColor(0xFF0000)
            ],
            ephemeral: true
          });
        }

        try {
          // Notify user before deleting
          const user = await client.users.fetch(ticketToDelete.user_id);
          await user.send({
            embeds: [
              new EmbedBuilder()
                .setTitle('🎟️ Ticket Deleted')
                .setDescription('Your ticket has been deleted by staff.')
                .setColor(0xFF0000)
                .setTimestamp()
            ]
          }).catch(() => console.log('Could not DM user about ticket deletion'));

          // Delete from database
          await activeTicketsCollection.deleteOne({
            channel_id: interaction.channel.id
          });

          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription('✅ Ticket deleted')
                .setColor(0x00FF00)
            ]
          });

          // Delete the channel after a short delay
          setTimeout(() => interaction.channel.delete(), 2000);

        } catch (error) {
          console.error('Error deleting ticket:', error);
          await interaction.reply({
            embeds: [
              new EmbedBuilder()
                .setDescription('❌ Failed to delete ticket')
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

// Message handling for tickets and ticket channels
client.on('messageCreate', async message => {
  // Enhanced logging for debugging
  const channelInfo = {
    type: message.channel.type,
    isDM: message.channel.isDMBased?.() || message.channel.type === 1 || message.channel.type === 'DM',
    guildId: message.guild?.id || 'DM',
    channelId: message.channel.id,
    author: message.author.tag,
    content: message.content?.substring(0, 100) // Log first 100 chars of content
  };
  console.log('Message received:', channelInfo);
  
  if (message.author.bot) return;

  // Handle messages in ticket channels
  if (message.channel.name?.startsWith('ticket-')) {
    const ticketData = await activeTicketsCollection.findOne({ 
      channel_id: message.channel.id,
      status: 'open'
    });

    if (ticketData) {
      // Forward message to ticket user
      try {
        const user = await client.users.fetch(ticketData.user_id);
        await user.send({
          embeds: [
            new EmbedBuilder()
              .setAuthor({
                name: message.author.tag,
                iconURL: message.author.displayAvatarURL()
              })
              .setDescription(message.content)
              .setColor(0x00FF00)
              .setTimestamp()
          ]
        });
      } catch (error) {
        console.error('Could not forward message to user:', error);
      }
    }
    return;
  }

  // Handle DMs - updated check for DM channels
  if (channelInfo.isDM) {
    console.log('Processing DM from:', message.author.tag);
    
    // Check for active ticket
    const activeTicket = await activeTicketsCollection.findOne({ 
      user_id: message.author.id,
      status: 'open'
    });

    console.log('Active ticket check:', activeTicket ? 'Found active ticket' : 'No active ticket');
    
    // Find a guild where the user and bot are both members
    const guild = client.guilds.cache.find(g => {
      const hasBoth = g.members.cache.has(message.author.id);
      console.log(`Checking guild ${g.name}:`, hasBoth ? 'Both members present' : 'Not both members');
      return hasBoth;
    });

    if (!guild) {
      console.log('No suitable guild found for user:', message.author.tag);
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setDescription("❌ Could not find a server where we can create your ticket! Please make sure we share at least one server.")
            .setColor(0xFF0000)
        ]
      });
    }

    console.log('Found suitable guild:', guild.name);

    if (activeTicket) {
      // Forward message to existing ticket
      const ticketChannel = guild.channels.cache.get(activeTicket.channel_id);
      if (ticketChannel) {
        await ticketChannel.send({
          embeds: [
            new EmbedBuilder()
              .setAuthor({
                name: message.author.tag,
                iconURL: message.author.displayAvatarURL()
              })
              .setDescription(message.content)
              .setColor(0x00FF00)
              .setTimestamp()
          ]
        });
      }
      return;
    }

    // Get ticket category
    const settings = await ticketSettingsCollection.findOne({ guild_id: guild.id });
    console.log('Ticket settings:', settings ? 'Found settings' : 'No settings found');
    
    if (!settings?.ticket_category) {
      return message.reply({
        embeds: [
          new EmbedBuilder()
            .setDescription("❌ The ticket system hasn't been set up yet! An admin needs to use /setticketcategory first.")
            .setColor(0xFF0000)
        ]
      });
    }

    try {
      // Create ticket channel
      console.log('Creating ticket channel in category:', settings.ticket_category);
      
      const channelName = `ticket-${message.author.username.toLowerCase().replace(/[^a-z0-9]/g, '-')}`;
      const channel = await guild.channels.create({
        name: channelName,
        type: 0,
        parent: settings.ticket_category,
        topic: `Support ticket for ${message.author.tag}`,
        permissionOverwrites: [
          {
            id: guild.roles.everyone.id,
            deny: ['ViewChannel']
          },
          {
            id: message.author.id,
            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory']
          },
          {
            id: client.user.id,
            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels']
          },
          {
            id: guild.id,
            allow: ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'ManageChannels']
          }
        ],
        reason: 'Ticket created via DM'
      });

      console.log('Successfully created ticket channel:', channel.name);

      // Save ticket in database
      await activeTicketsCollection.insertOne({
        channel_id: channel.id,
        user_id: message.author.id,
        guild_id: guild.id,
        status: 'open',
        created_at: new Date()
      });

      // Send initial message to ticket channel
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('🎟️ New Ticket')
            .setDescription(`Ticket created by ${message.author.tag}`)
            .addFields(
              { name: 'User', value: `<@${message.author.id}>` },
              { name: 'Initial Message', value: message.content }
            )
            .setColor(0x00FF00)
            .setTimestamp()
        ]
      });

      // Notify user
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setTitle('🎟️ Ticket Created')
            .setDescription('Your ticket has been created! Staff will respond shortly.')
            .setColor(0x00FF00)
        ]
      });

    } catch (error) {
      console.error('Error creating ticket:', error);
      await message.reply({
        embeds: [
          new EmbedBuilder()
            .setDescription('❌ Failed to create ticket. Please try again later.')
            .setColor(0xFF0000)
        ]
      });
    }
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
