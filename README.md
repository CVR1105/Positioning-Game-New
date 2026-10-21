# Positioning Strategy Game: multiplayer edition

A real-time, multi-laptop version of the Marketing & Positioning Simulation Game.
It supports up to 10 teams and 8 rounds, with results after every round, team-coloured
charts, a final leaderboard and a facilitator console. Players need **only a browser and the link**,
with no accounts, no Claude subscription and no installs.

- **Full rules, house rules and complete game logic:** open `/how-to-play` on the running game,
  or `HOW-TO-PLAY.pdf` in this folder.
- **Zero dependencies:** Node.js 18+ only. Nothing to `npm install`.

---

## 1. Run it (pick one)

### A. Free public link on Render (recommended, about 5 minutes)
1. Create a free GitHub account and a **new repository**, then upload all the files in this folder
   (GitHub → *Add file → Upload files* → drag the folder contents → *Commit*).
2. Create a free account at **render.com** → *New + → Blueprint*, then pick your repository.
   Render reads `render.yaml` automatically. Click **Apply**.
   (Or use *New + → Web Service*, pick the repository, Build command `echo ok`, Start command `node server.js`, plan *Free*.)
3. After about 2 minutes you get a URL like `https://positioning-game-xxxx.onrender.com`. Anyone with that link can play.

> Render free-tier notes: the server sleeps after 15 minutes with **no** visitors. The first visit then takes
> about 30–50 seconds to wake it. During a game the open browsers keep it awake. A sleep or redeploy wipes saved
> games on the free plan, so **export the CSV/JSON from the console at the end of each session**. For permanent
> storage, add a Render *Disk* (paid) mounted at `/data` and set the env var `DATA_DIR=/data`, or use Railway (below).

### B. Railway / Fly.io / any Docker host
`Dockerfile` is included and stores data in `/data`. On Railway: *New project → Deploy from GitHub repo*,
then add a **Volume** mounted at `/data`. Games then survive restarts permanently.

### C. Classroom laptop + free internet link (no hosting account)
On the facilitator's laptop (Node.js 18+ installed):
```bash
node server.js                                      # game at http://localhost:3000
npx cloudflared tunnel --url http://localhost:3000  # prints a public https://….trycloudflare.com link
```
Share the `trycloudflare.com` link. It works from any network for as long as the laptop stays on.

### D. Same Wi-Fi only (LAN)
Run `node server.js` and share `http://<your-laptop-IP>:3000`
(find the IP with `ipconfig` on Windows or `ifconfig` / `ip addr` on Mac/Linux). Allow Node through the firewall if asked.

---

## 2. Running a session
1. Open the site → **Host a game** → set a facilitator PIN, rounds (8), timers and options → **Create game**.
2. Share the team link shown in the console (or the 6-character code). Open **📺 Projector view** on the big screen.
3. Teams join with a **team name + team PIN**. Teammates use the same name and PIN on other laptops.
4. Click **Start round 1**. Each round is processed automatically when every team has submitted
   (or click **Process round**, or let the timer run out). Everyone then watches the simulation and the results.
5. Click **Open round N** after each results screen. After round 8, click **Reveal final leaderboard** 🏆.
6. Download **CSV / JSON** for grading.

Facilitator console: `/#/g/<CODE>/admin` (log in with the facilitator PIN from any device).

---

## 3. Rules summary (full detail in the How to Play guide)
| Item | Rule |
|---|---|
| Start budget | 5,000 points (budget each round = accumulated profit) |
| Grid | Rows A (high style) → J (basic), columns 1 (low quality) → 10 (high quality); START = J1 |
| Cost | 200 points per cell moved, horizontal/vertical only; launch cost = distance from J1 |
| Sales | cell demand ÷ number of products in that cell × (1 + loyalty bonus) |
| Loyalty | 1.10^(rounds held in a row) − 1; resets on launch or reposition (up to +94.9% by round 8) |
| Products | max 20 per team over the game (withdrawn ones still count) |
| **House rule 1** | Launched products cannot be removed or deleted; they stay in the portfolio |
| **House rule 2** | Withdrawing a product costs a **double penalty**: 2 × lifetime loss if loss-making, otherwise 2 × the cost of moving it back to START |
| **House rule 3** | **At least one move every round** (launch / reposition / withdraw). Only waived if budget < 200 |
| Missed submission | the team holds all products (no cost); results mark it "no submission" |
| Winner | highest accumulated profit after the final round |

---

## 4. Architecture
| File | Purpose |
|---|---|
| `engine.js` | Pure game logic (validation, costs, sales, loyalty, penalties, ranking, news). Shared by the server and the browser, so previews always match the real results |
| `server.js` | HTTP API, Server-Sent Events for live push, round state machine, timers, auth, privacy filtering, CSV/JSON export, atomic JSON persistence (`data/game-<CODE>.json`) |
| `public/` | Single-page app (team, facilitator, projector views), styles, and the How to Play guide |
| `test/` | `simulate.js`: full 8-round games over HTTP with 6 and 10 teams, checking every number. `timers.js`: timers, missed submissions, restart recovery, loyalty |

**Reliability.** The server is the single source of truth, and every change is saved to disk before it is
broadcast. Every action carries the round number, so double clicks and stale tabs can't skip or repeat a
round. Browsers receive live pushes and also poll every 4 seconds, so a dropped connection recovers by itself.
Deadlines are stored as timestamps, so timers survive a server restart.

**Privacy.** During a round, a team's browser receives only its own plan and decision; other teams appear as
"submitted ✓" or "…" only. Tokens and PINs are never sent to other teams, and PINs are stored hashed.

Run the tests: `npm test`
