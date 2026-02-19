# Deployment Guide

You asked if it's possible to host this game on **GitHub Pages**.

## ❌ **GitHub Pages: No**
GitHub Pages only hosts **static** files (HTML, CSS, JavaScript). It cannot run the **Node.js server** required for this game's real-time multiplayer logic (Socket.io).

## ✅ **Render / Railway / Heroku: Yes**
You need a hosting provider that supports Node.js. **[Render](https://render.com)** has a free tier that is perfect for this.

## How to Deploy on Render (Free)
I have already included a `render.yaml` file in your repository to make this easy.

1.  **Push code to GitHub** (I just did this for you!).
2.  **Go to [Render Dashboard](https://dashboard.render.com)**.
3.  Click **New +** -> **Web Service**.
4.  Connect your GitHub repository: `kosuvorov/PartyGame`.
5.  Render will automatically detect the `render.yaml` configuration.
6.  Click **Create Web Service**.

Wait about 1-2 minutes, and Render will give you a public URL (e.g., `https://party-game.onrender.com`). You can share this link with friends to play anywhere!
