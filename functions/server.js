const express = require('express');
const app = express();
const PORT = process.env.PORT || 0000;

app.get('/', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Shitheads up!</title>
        <style>
@import url('https://fonts.googleapis.com/css2?family=Montserrat:ital,wght@0,100..900;1,100..900&display=swap');

          body { font-family: "Montserrat", "Arial", sans-serif; text-align: center; padding: 50px; background: #222222; color: white }
          h1 { color: #ff6600; }
        </style>
      </head>
      <body>
        <h1>Derivative Discord Bot</h1>
        <p>Bot is running and ready to chat!</p>
        <p>Invite the bot to your Discord server to start using it.</p>
                <p>Please visit <a href="https://shitheads.instatus.com"><b>shitheads.instatus.com</b></a> instead. Why are you here, actually?</p>
      </body>
    </html>
  `);
});

app.get('/status', (req, res) => {
  res.json({
    status: 'online',
    bot: 'Garfield Discord Bot',
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Web server running on port ${PORT}`);
});

module.exports = app;
