# Northstar Desk — Open-Source Developer Tool Proposal

> **Tagline:** Your projects, picked up where you left them.  
> **Platform:** Windows-first desktop app  
> **Approach:** Open source, local-first, AI-optional  
> **Primary goal:** Improve the creator’s workflow while building something other developers may adopt.

## 1. The Problem and Opportunity

The core problem is losing context across projects. Work is spread across repositories, university assignments, experiments, hackathons, product ideas, coding sessions, and notes. When returning to a project, it can take time to reconstruct:

- What was I working on?
- What changed since the last session?
- Why did I make a particular decision?
- What is still unfinished?
- What should I do next?

There are already tools for coding-agent memory, project notes, session history, and Git workflows. The opportunity is **not to build another AI memory engine**. It is to build a unified Windows desktop experience that makes it easy to find the right context and resume work across projects—including work that does not happen inside an AI coding agent.

This is a product hypothesis to validate, not a proven market gap. Existing tools may already cover parts of the workflow.

## 2. Product Concept

### Northstar Desk

A local-first developer workspace that combines project information, Git activity, session notes, decisions, unfinished tasks, and the next action in one place.

The core workflow should take seconds:

1. Open Northstar Desk.
2. See registered projects and their last recorded context.
3. Choose a project and understand where work stopped.
4. Resume the project in the configured editor.
5. Record a short handoff before finishing the session.

### Core capabilities

#### A. One place for all projects

Register projects such as Bud Bud, university assignments, open-source contributions, experiments, and hackathon work—even if they do not use an AI coding agent.

#### B. A timeline of work

Combine Git activity, manually recorded decisions, unfinished tasks, recent sessions, and the next action.

Git tells you what changed; your journal explains why.

#### C. A native-feeling Windows experience

Open the project, recover its context, and launch the configured editor. Avoid requiring the user to remember to open a separate browser dashboard.

#### D. Quick context capture

Record what you are doing, what you learned, what blocked you, and what you need to do next. Capturing context should be faster than writing a journal entry.

## 3. Proposed User Interface

The first version needs only three main screens.

### Home

- Registered projects
- Last activity
- Current Git branch and working-tree state
- Last session summary
- Next action
- One obvious **Resume** action

### Project view

- Chronological session history
- Decisions and observations
- Unfinished tasks
- Recent commits
- Current Git state
- Project-specific launch configuration

### Quick capture

A compact panel for recording:

- What I worked on
- What I learned
- What failed or blocked me
- What I decided
- What I should do next

The design should be calm, minimal, and focused on utility rather than decorative dashboards.

## 4. Example Resume Screen

Illustrative content:

**Bud Bud**  
Last worked on: Yesterday

- **Last session:** Refined task reminder behavior.
- **Unfinished:** Repeated postponement flow has not been tested.
- **Next step:** Write tests for three consecutive postponements.

Actions:

- **Resume** — open the project and its configured editor.
- **View history** — review previous sessions and notes.

This is a product concept, not a live application or repository data.

## 5. Existing Tools and the Potential Differentiator

Existing projects already cover parts of this problem, including project notes, coding-agent memory, session histories, and developer workspaces.

Examples to investigate:

- **Sidecar:** https://sidecar.haplab.com/
- **Quick Shell:** https://github.com/tonythethompson/QuickShell
- **termem:** https://termem.com/
- **projectmem:** https://github.com/Atarity/projectmem
- **deja-vu:** https://github.com/search?q=deja-vu+coding+agent+session+history&type=repositories

These are starting points for competitive research, not a definitive or exhaustive market analysis. Verify current project status, features, licenses, and installation instructions before making product decisions.

| Capability | Existing tools | Northstar Desk's proposed angle |
|---|---|---|
| Project decisions and session notes | Already supported by several tools | Make them easy to review across registered projects |
| Coding-agent memory | Several tools specialize in this | Integrate existing context instead of rebuilding their memory engines |
| Git activity | Available in Git tools and developer utilities | Put it beside the last session and next action |
| Windows project hub | Varies by product | Make switching and resuming projects the central workflow |
| Work outside coding agents | Varies by product | Support university work, manual coding, research, and non-agent sessions |

The most promising potential differentiator is the combination of **cross-project context, a Windows-first workflow, and support for work that happens outside coding agents**. These are hypotheses to test against existing tools and real use.

## 6. Technical Architecture

Recommended stack:

- **Tauri 2:** Native desktop shell and access to OS capabilities without requiring a heavyweight Electron app.
- **React + TypeScript:** UI and application logic.
- **SQLite:** Local structured storage for projects, sessions, notes, and next actions.
- **Git:** Branch, working-tree status, and recent commit information.
- **Native Tauri backend:** Controlled filesystem and process operations.
- **No required LLM:** The first version should work without an API key, internet access, or recurring AI costs.

### Architecture overview

```text
React + TypeScript
  - Home
  - Project view
  - Quick capture
        |
        v
Tauri 2 desktop shell
  - Safe native commands
  - Project folder access
  - Configured editor launch
        |
        +------------------+
        |                  |
        v                  v
     SQLite            Git + filesystem
  - Projects          - Branch
  - Sessions          - Working-tree state
  - Notes             - Recent commits
  - Next actions      - Project paths
```

Use the native backend for filesystem and process operations. Do not let the frontend execute arbitrary shell commands. Validate project paths, handle errors, and make launch commands explicit and configurable.

### Suggested repository structure

```text
northstar-desk/
├── apps/
│   └── desktop/
│       ├── src/
│       │   ├── components/
│       │   ├── pages/
│       │   └── features/
│       └── src-tauri/
│           └── src/
├── packages/
│   └── core/
│       ├── projects/
│       ├── sessions/
│       └── git/
├── tests/
├── README.md
├── CONTRIBUTING.md
└── LICENSE
```

This structure is a direction, not a requirement. Start with a single application if a monorepo adds unnecessary overhead.

## 7. Initial Data Model

Start with four entities. Do not introduce embeddings, vector databases, agent orchestration, or a knowledge graph in the first release.

### Project

- `id`
- `name`
- `root_path`
- `created_at`
- `last_opened_at`

### Session

- `id`
- `project_id`
- `started_at`
- `ended_at`
- `summary`

### SessionNote

- `id`
- `session_id`
- `kind`
- `content`
- `created_at`

Possible note kinds: `decision`, `blocker`, `learning`, `observation`.

### NextAction

- `id`
- `project_id`
- `description`
- `status`
- `created_at`

A project can have many sessions. A session can contain multiple notes. A project can have one or more unfinished actions. Keep the next action explicit and editable rather than burying it in an AI-generated paragraph.

### Privacy and data ownership

- Store project paths and context locally by default.
- Do not copy or upload entire source repositories.
- Make transcript imports opt-in if they are added later.
- Provide exclusions and deletion controls.
- Never require cloud sync or an AI provider for core functionality.

## 8. MVP Scope

The first milestone is:

> **Resume a project in 10 seconds.**

Target a working local prototype, not a polished public release.

### Implementation checklist

- [ ] Create the Tauri + React + TypeScript application.
- [ ] Establish the SQLite connection and migrations.
- [ ] Add a project by selecting an existing local folder.
- [ ] Display registered projects and each project's last recorded next action.
- [ ] Save a session note and an unfinished next action.
- [ ] Read Git branch, working-tree status, and recent commit information.
- [ ] Open the project folder in the configured editor.
- [ ] Close and reopen the app; verify the context persists.

### Acceptance criteria

The milestone is complete when you can:

1. Register Bud Bud and another real project.
2. Record a concrete next step for each.
3. Close the application completely.
4. Reopen it and see the correct context for both projects.
5. Resume the correct project without searching through old chats or manually reconstructing notes.

If this does not save time in your actual workflow, do not add AI features to hide the problem.

## 9. Build Plan

### Week 1 — Project registration and session notes

- Scaffold the desktop application.
- Set up SQLite.
- Register projects.
- Add and display notes and next actions.
- Verify persistence after restart.

### Week 2 — Git and project launching

- Read Git branch, status, and recent commits.
- Add configured editor launch.
- Handle missing folders, non-Git projects, and launch errors.

### Week 3 — Make context easier to resume

- Improve the project switcher.
- Add a global keyboard shortcut if feasible.
- Add a generated handoff document or a structured session summary.
- Test the workflow on several real projects.

### Week 4 — Release preparation

- Write a clear README.
- Add screenshots and a short demo.
- Document the data model and privacy approach.
- Add tests for core behavior.
- Publish a usable open-source release.

These are targets, not guaranteed deadlines. Prioritize a reliable end-to-end workflow over a feature-complete interface.

## 10. Roadmap After the MVP

Add features only in response to real problems encountered while using the app.

### Next

- Background Git refresh
- Global keyboard shortcut
- Better project switching
- Configurable editor and terminal launch

### Later

- Coding-agent session-history integrations
- Search across past sessions
- Generated handoff documents
- Project templates
- Optional local or API-based summarization

### Eventually

- Plugins for other editors and workflows
- Import/export for project context
- Optional sync, only if users genuinely need it

Do not build all of this before releasing the MVP.

## 11. Open-Source Adoption Strategy

To make the tool useful to people beyond its creator:

1. Make the Windows installation process simple.
2. Keep the app useful without an account, cloud service, or AI API key.
3. Document the local data format.
4. Include screenshots and a short, real-world demo.
5. Make bugs and feature requests easy to submit.
6. Provide a contribution guide and automated tests.
7. Choose a license intentionally. MIT is one reasonable option if its terms fit the project's goals.
8. Explain clearly how project paths and notes are stored and how users can delete their data.

The product should earn adoption through utility, reliability, and trust—not by promising that AI will magically remember everything.

## 12. Immediate Validation Before Coding

Spend one evening trying an existing tool, such as Sidecar, on two real projects.

Suggested starting point: https://sidecar.haplab.com/

While using it, record three things you still had to do manually. Those become requirements for Northstar Desk.

Ask:

- Can I recover context from a non-agent coding session?
- Can I see the next action without reading a long summary?
- Can I switch between projects without rebuilding context?
- Does it fit naturally into my Windows workflow?
- What would make me use this every day instead of forgetting it exists?

If an existing tool already solves the problem, do not build a clone out of attachment to the idea. Narrow the scope to a real, recurring gap.

## 13. Product Principle

The goal is not to build the most impressive-looking tool. The goal is to use it every day, discover its shortcomings, fix them, and build a public record of the engineering decisions behind it.

This project can provide three outcomes:

1. A tool that improves your own workflow.
2. A real open-source project through which you deepen your engineering skills.
3. Evidence of how you think, build, test, and maintain software.

**Success criterion:** Northstar Desk becomes a tool you personally keep open every day—and only then do you ask other developers to use it.

---

## Short Product Summary

**Northstar Desk** is a Windows-first, local-first open-source developer context app. It brings together project registration, Git activity, session notes, decisions, unfinished work, and next actions so developers can resume projects without reconstructing context from old chats and scattered notes.

Its first version will use Tauri 2, React, TypeScript, SQLite, and Git. The MVP is complete when a developer can register two projects, record their next steps, restart the app, recover both contexts, and resume the correct project in seconds.

**Build the smallest version that solves the problem for you. Validate the gap against existing tools. Add integrations only when real use demands them.**
