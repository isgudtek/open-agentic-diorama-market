# Inspiration

Cognizant AI Lab's videos of the **worldwide agentic web** prototype showed us an idea we hadn't seen working anywhere else: websites that carry their own agents, publish them as plain JSON, and let other sites' agents talk to them right in the visitor's browser.

The new standards behind it made that concrete:

- **The Minimum Viable Specification for a Worldwide Agentic Web** (MVP Profile 0.2). A site publishes an `agent-manifest.json`, describes its agents as data rather than code, runs them in the browser, and lets the visitor choose the model.
- **Neuro SAN agent networks and the nsDeploy reference runtime**, which show how a multi-agent graph can move between sites.
- **Bring-your-own-model** options that only recently became practical in a browser: **Mozilla Otari** as one OpenAI-compatible gateway for many providers, and **Chrome's built-in Gemini Nano**.

We wanted to test the idea on something people actually buy and argue about: price. A custom scale diorama is a good case. Every order is unique, it has to be designed before it can be priced, and buyer and maker have to agree on a number. So we built two websites that have never met, and let their agents do business.

# What it does

**Open Agentic Procurement: Dioramas** is two independent agentic websites:

- **OpenAgentic Procurement Hub** (the buyer). You type a commission in plain language, for example *"a 1:35 WWII desert trench diorama, 40x40cm, with a resin river and LED explosions, budget $450"*.
  - `intake_agent` turns it into a structured request for quote (RFQ).
  - `discovery_agent` reads suppliers' public `agent-manifest.json` files and picks one that publishes `diorama.quote`.
  - `negotiator_agent` asks for a quote and counter-offers within your budget.
- **Miniature Worlds 3D Diorama Studio** (the maker).
  - `diorama_designer` turns the RFQ into a **live 3D scene in Three.js**: terrain, trenches, ruins, a resin river, flickering LEDs. Everything is procedural geometry.
  - `diorama_estimator` prices it from materials and labour hours, applies scale rules, and negotiates.
  - `workshop_operator` updates the 3D preview and the commission board.

The two sites negotiate live in your browser. In the demo the studio quotes **$500**, the hub offers **$430**, the studio comes back with **$465**, and the hub's **$450** is accepted.

**You stay in control:**

- **Nothing is written without your approval.** Every write pauses on an **"Approve Action?"** card that shows the exact payload, the price and the target site. That covers placing the order on the hub, and logging the RFQ and locking a build slot on the studio.
- **Rules are enforced in code, not left to the model.** The hub never accepts or orders above your budget. The studio never goes below its 12% discount floor.
- **You choose the model on each site:**
  - **Mozilla Otari** with your own key (global or EU region, plus a list of the models your organization can use)
  - **Gemini Nano** on your device
  - **Hybrid** (Nano first, Otari as fallback)
  - **Demo Mode**, which needs no key, so anyone can try it
- **You can watch everything.** A live **execution stream** shows every agent handoff across both sites, every manifest fetch, and the provider, time and tokens of every model call. A **Manifest Inspector** shows each site's published agents and checks them against the spec.

# How we built it

- **No backend, no build step, no dependencies.** Both sites are plain HTML, CSS and ES modules. A 75-line Node dev server serves them on two ports with CORS. The live version runs on GitHub Pages.
- **Agents are data.** Each site's network file holds every agent's instructions and output schema, and the runtime loads it through the site's `agent-manifest.json`.
- **The model proposes, the code decides.** Every model output is validated against its schema, then normalized: scenes are clamped inside the base, unknown structure types dropped, missing features restored. Business policy runs in plain functions that are unit-tested on their own.
- **Cross-site protocol.** The sites talk over `window.postMessage`:
  - `OAW_RPC_REQUEST` / `OAW_RPC_RESPONSE` for calls
  - `OAW_RPC_EVENT` so the hub can show the studio's agents working in real time
  - origin checks on both sides, and consent for unknown callers
- **One shared runtime** for both sites, with these providers:
  - **Mozilla Otari**: OpenAI-compatible `chat/completions`, JSON mode, model discovery via `/models`
  - **Gemini Nano**: Chrome Prompt API with `responseConstraint`
  - **Hybrid** and **Demo**
- **Both sites expose `window.OpenAgenticWeb`** (`manifest`, `run`, `callTool`, `getState`), so other pages, extensions or agents can drive them.
- **Tested in a real browser.** Headless Chrome runs the full commission across both sites and clicks every approval. Mocked Otari errors, a Gemini Nano that never answers, and a model that returns empty JSON all have their own tests.

# Challenges we ran into

- **Small models don't follow orders.** Gemini Nano sometimes ignored the JSON format, and some Chrome builds rejected structured output with `kErrorUnknown`. On slower machines it could take longer than 30 seconds to write a full 3D scene. We added a JSON extractor, one retry, a time limit that can't hang, and a fallback that skips Nano for a few minutes after it fails.
- **Models hand back nonsense, and politely.** In one test the model left out the counter-offer price, the code read that as `0`, and the hub offered **$1**. The studio's floor rule caught it, but that run is why the hub has its own policy layer now.
- **Real-world gateway errors.** Otari keys belong to a region (a 421 means "use the EU endpoint"), and an organization may not have credentials for every provider (424). The site now switches region automatically, but only between Otari's own hosts, and lists the models the key can actually run.
- **Invisible characters.** A pasted key containing an invisible character broke `fetch` with an unhelpful error. We now strip those and name any character that can't be sent.
- **Static hosting surprises.** GitHub Pages caches files for 10 minutes, so visitors kept running old code after a fix. Every file URL now carries a content hash, and the build ID shows in the stream.
- **One CSS class name blanked the whole page.** The class that opened the split view also matched a rule that hid the page.

# Accomplishments that we're proud of

- **Two websites that have never met strike a real deal.** They discover each other, design the product in 3D, negotiate and confirm an order, all from published JSON with no server and no shared code.
- **Human approval is built into the protocol.** Writes are approved on the site that owns them, even when another site requests them.
- **The model can't break the rules.** Budgets, discount floors and scale limits are enforced in code. Whenever the model's proposal gets overruled, the stream says so.
- **It works for everyone:**
  - with your own Mozilla Otari key
  - fully on-device with Gemini Nano
  - with no key at all in Demo Mode
- **A procedural 3D viewport** that turns an agent's JSON into a diorama you can orbit in seconds.

# What we learned

- **Publishing agents as data changes the conversation between sites.** Once a site's capabilities are a JSON file, discovery is just a `fetch`, and checking a site against the spec is a set of yes/no questions.
- **Treat model output as a proposal, never a decision.** Schemas, normalization and policy functions made the agents dependable, and they work the same with Otari, Nano or Demo Mode.
- **Bring-your-own-model is a UX problem as much as an API problem.** Regions, provider credentials, model lists, pasted keys and slow local models all need clear messages and sensible defaults.
- **Consent and approval should belong to whoever owns the data.** The hub can ask the studio to lock a slot, but only the studio's owner can approve it.

# What's next for Open Agentic Procurement: Dioramas

- **More suppliers.** Let the hub compare quotes from several studios side by side, and pick on price, lead time and the 3D blueprint.
- **Truly separate hosting.** Put each site on its own domain, so the live demo is cross-origin like the local one.
- **Shared, persistent boards.** Swap the studio's local board store for Firebase, so orders survive across devices and studio staff can work the queue together.
- **Richer 3D.** Add more structure types, editable blueprints the buyer can tweak before ordering, and a snapshot of the approved scene saved with the order.
- **Trust and payments.** Signed manifests, supplier reputation, and deposits or escrow on confirmation.
- **Wider interoperability.** MCP tools, an A2A agent card, and a public registry so any agentic site can find studios like Miniature Worlds.
