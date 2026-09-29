<div align="center">

# 🎯 dsh-career-planner

**A job-hunt manager that lives inside DeepSeek Harness**

Career profile, job postings, application tracking, skills, and resumes — all inside your AI conversation.

[![npm](https://img.shields.io/npm/v/dsh-career-planner?color=blue)](https://www.npmjs.com/package/dsh-career-planner)
[![license](https://img.shields.io/badge/license-MIT-green)](LICENSE)

[中文](README.md) ｜ [**English**](README.en.md)

</div>

---

## What it is

A DSH plugin that gives you a **conversational job-hunt assistant** (Not limited to computer science).

It does two things:

- **Adds a "Career Planning" panel to the right sidebar** — 5 tabs: Profile / Applications / Jobs / Skills / Resumes. Click around and manage everything.
- **Ships a "Career Planner" agent preset** — the AI can read your career data during chat, and write back to it.

> 🗣️ Yes — **you and the AI operate on the same data.** Change an application status in the UI and the AI knows it on the next message. Tell the AI "I just finished my second interview at ByteDance" and it lands in the database; refresh the panel and it's there.

### Why I built this

> It's fall recruitment season, and my own turn comes next year 😭 ~~gotta build something before facing reality~~
> Every corner of computer science is being written off right now, and this mouse is thoroughly lost. Then I got hooked on DSH, and figured I'd turn it into my own personal career coach — but I searched the DSH community and found nothing for job hunting. So I dragged invited <img src="https://avatars.githubusercontent.com/u/148330874?v=4" width="16" height="16" alt="DeepSeek"> **Big Fatty Fish** to write one ~~with me~~, and I've been using and tweaking it ever since.
>
> For now it's just me using it. **There are almost certainly bugs I haven't found** — one person writing and testing has limited eyesight. Issues are very welcome and I'll do my best to fix them.
>
> More features are planned, and I'll update when I can. If this plugin helps you, **please give it a Star** ⭐ — it's what keeps this mouse going 🙏
---

## Core design

### Feature 1: The AI and the user share one data layer

This isn't "an AI plugin plus a separate management UI". **The UI and the AI run the same code over the same files**:

```
You chat with the AI ──→ career_write ──┐
                                        ├──→ career-store.mjs ──→ <workspace>/career/*.json
You click the panel  ──→ HTTP API ──────┘
```

What that feels like:

| You say | What happens |
|---|---|
| "Find me some LLM-related openings" | AI searches the web → writes them into the job pool → they appear in the panel |
| "Can I apply to this one?" | AI reads your profile + that posting → scores the match → names your biggest gap |
| "I just applied to ByteDance" | AI records it → the panel's status updates |
| "I want to learn Rust" | AI assesses the gap → adds it to your learning path → a skill with a deadline appears |
| "Review my resume" | AI reads the original (**never modifies it**) → parses to Markdown → finds gaps against target postings |

### Feature 2: Your profile accumulates while you just… chat

This is my favourite part — **you never have to sit down and "fill in a form"**.

You're just talking normally:

> "I'm at a non-211 school, studied CS, mainly Java, recently pivoting to LLM, applied to a dozen places with no reply…"

The AI breaks that into **structured profile tags** (education / tech stack / direction / current state) and writes them to `profile.json`.

But it **never treats a guess as a fact**. Every tag carries a source and a confirmation state:

| Source | Trust | Behaviour |
|---|---|---|
| `user_explicit` | You said it | Takes effect immediately |
| `resume_parsed` | Parsed from your resume | Goes to "pending confirmation" — **only counts once you confirm** |
| `ai_inferred` | Inferred by the AI | Same — needs your confirmation |

> 💡 So the AI understands you better the more you use it, but it **never oversteps** — unconfirmed tags don't enter any formal conclusion.

### Feature 3: The AI supervises your learning (and it won't go easy on you)

You don't have to guess what to learn — **the skill list grows straight out of the job pool**.

Add skills by hand, or have the AI scan the job pool and pull in the ones that keep coming up. Deadlines are set by difficulty (easy 7 days / medium 21 / hard 45), and when they come due the AI quizzes you.

The important part is that **this exam is for real**:

- A skill **cannot be marked "passed" by hand** — you have to actually pass an exam; this is hard validation
- The questions come from <img src="https://avatars.githubusercontent.com/u/148330874?v=4" width="16" height="16" alt="DeepSeek"> **Big Fatty Fish** (that is, DeepSeek) — and a bad answer simply doesn't pass

> 🐟 Big Fatty Fish is no people-pleaser ~~(not naming any specific doubao here)~~. It won't flip "learning" to "passed" just because it feels sorry for you.
> Want its approval? Earn it.

**This is the most valuable part of the plugin**: on a job hunt, what you lack isn't information — it's **someone making sure you actually finish learning what you should**.

---

## Features

### 📋 Profile

Career profile tags, grouped by dimension (education / tech stack / direction / preferences / gaps…).

- Coloured dimension bars + overview stats
- Unconfirmed tags highlighted separately, one-click confirm
- Add, edit, and delete tags by hand

### 📮 Applications

Application records with a state machine.

- Status **only moves forward**: applied → assessment → interview → offer (`force` can skip ahead, but **never backwards**)
- Clicked wrong? There's "undo last status change"
- Filter by status / company + keyword search
- Every record carries a full timeline

### 💼 Job pool

Your pool of postings, with automatic lifecycle management.

- AI collects from the web — a posting **must carry a source and link** to be accepted
  > 💡 Strongly recommended: pair this with a browser plugin, so the AI can use **your already-logged-in browser** to gather postings.
  > We recommend Tencent's open-source [**BrowserSkill**](https://github.com/Tencent/BrowserSkill): it reuses your real login session, runs in a separate window without interrupting you, and hands control back to you when a CAPTCHA appears. With it installed in DSH, the success rate and quality of job collection goes up noticeably.
- Not updated for 15 days → marked stale → link checked → pending deletion → 1-day grace → removed
- Link checking is **deliberately conservative**: 403 / timeouts count as "cannot confirm", so it **never deletes by mistake** (job sites are full of anti-bot walls)
- Each posting has a "ask the AI" shortcut

### 🛠️ Skills

Skill list + exam records.

- A skill has **exactly two states**: learning / passed
- ⚠️ **You cannot mark a skill "passed" by hand** — you have to actually pass an exam (hard validation, to stop you fooling yourself)
- Deadlines suggested by difficulty (easy 7 days / medium 21 / hard 45)
- Reminders as they come due

### 📄 Resumes / Graph

- **Your resume originals are never modified** — uploaded PDFs / docx are read-only; parsing writes a new `.md`
- Supports docx / pdf / doc / txt / md / images (images go through OCR). Parsing is powered by `officeparser`, which the plugin installs automatically; **if it fails to install, nothing breaks** — there's a built-in zero-dependency fallback that still reads text-based docx / pdf
- The skill graph is derived from the job pool and can be recomputed at any time

### 🤖 The 8 AI skills

The preset bundles 8 skill manuals that the AI loads on demand:

| Skill | What it does |
|---|---|
| `career-profile` | Interview-style profile collection |
| `jd-sourcing` | Searches the web for real openings |
| `jd-analysis` | Breaks down a posting, scores the match, judges whether it's worth applying |
| `jd-tagging` | Applies tech tags + maintains a growing vocabulary |
| `resume-review` | Analyses your resume and suggests edits |
| `interview-experience` | Finds real interview reports online and prepares you |
| `learning-path` | Turns skill gaps into a learning path |
| `direction-advice` | Evaluates career directions and trade-offs |

---

## Installation

### Option 1: From npm (recommended)

```bash
dsh plugin --profile web add dsh-career-planner
```

### Option 2: From GitHub

```bash
dsh plugin --profile web add github:coderoadline/dsh-career-planner
```

### After installing

**Restart DSH.** Then:

1. Start a new session → pick "**Career Planner**" in the preset selector
2. The "**Career Planning**" panel appears in the right sidebar

On first run the data directory is created automatically under your workspace (`<workspace>/career/`).

---

## Where your data lives

Everything sits in **your workspace** as plain JSON — copy it, back it up, take it anywhere:

```
<workspace>/career/
├── profile/profile.json         # career profile
├── jobs/jobs.json               # job pool
├── applications/applications.json
├── skills/skills.json
├── graph/skill-graph.json       # skill graph (generated)
├── resumes/                     # resume originals (read-only)
└── logs/events.jsonl            # audit log (append-only)
```

---

## Troubleshooting

**The AI reports "cannot find the career data-layer code"**
The plugin isn't enabled. The AI tools get their data-layer code from the plugin, so the two must be installed together.

---

## License

[MIT](LICENSE)
