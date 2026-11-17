# Open Agentic Diorama Market

Three independent, static agentic websites: a buyer hub and two competing diorama studios. They find each other through their public `agent-manifest.json` files and do business in the visitor's browser. The hub asks both studios for a quote, both design their own 3D diorama side by side, you choose one, and the hub negotiates and asks you to approve the order. There is no backend and there are no dependencies. Built for the [Cognizant Open Agentic Web Challenge](https://github.com/cognizant-ai-labs/agentic-web).

> The earlier single-studio version is archived at [isgudtek/open-agentic-dioramas](https://github.com/isgudtek/open-agentic-dioramas) (tag `v1-single-shop`), live at https://isgudtek.github.io/open-agentic-dioramas/.

| Site | Role | Local | Live |
| --- | --- | --- | --- |
| **OpenAgentic Procurement & Commission Hub** (`buyer-hub/`) | Buyer agents: RFQ, supplier discovery, quote comparison, negotiation, approved order | http://localhost:62260 | https://isgudtek.github.io/open-agentic-diorama-market/buyer-hub/ |
| **Miniature Worlds** (`diorama-studio/`) | Supplier: fast and premium, 12% discount floor | http://localhost:62261 | https://isgudtek.github.io/open-agentic-diorama-market/diorama-studio/ |
| **Frostbite Miniatures** (`frostbite-studio/`) | Supplier: dense natural detail, cheaper, slower, 8% discount floor | http://localhost:62262 | https://isgudtek.github.io/open-agentic-diorama-market/frostbite-studio/ |

Frostbite runs the same studio code as Miniature Worlds. `frostbite-studio/` only holds what makes it a different business: `shop.json` (name, prices, lead times, discount floor, design style), its own `agent-manifest.json` and agent network, and a colour theme.

## Run locally

```bash
npm start          # node dev-server.js: all three sites, CORS on, no install needed (Node 18+)
npm run verify     # HTTP conformance checks across the three ports
```

Open http://localhost:62260, click the first example and press **Run commission**:

1. On the hub, allow contact with each studio (two prompts locally, none on GitHub Pages where all sites share one origin).
2. Both studios open in the split view and each renders its own 3D blueprint. The hub shows the two quotes side by side: Miniature Worlds **$500, 7 days** (over budget) and Frostbite **$450, 12 days** (within budget).
3. Click **Choose this quote**, or **Let the agent pick** (within budget first, then lowest price, then fastest).
4. If the chosen quote is over budget, the hub negotiates: for Miniature Worlds $500 → you $430 → $465 → you $450, accepted.
5. Approve the order on the hub, then the build-slot lock in the chosen studio's pane.

Comparison quotes write nothing: only the studio you choose puts the order on its board.

## How it works

```mermaid
sequenceDiagram
  participant U as You
  participant A as Buyer Hub :62260
  participant B as Diorama Studio :62261
  U->>A: "1:35 WWII desert trench, 40x40cm, river, LEDs, budget $450"
  A->>A: intake_agent → RFQ JSON
  A->>U: Contact localhost:62261? (consent)
  A->>B: GET /agent-manifest.json + network JSON (CORS)
  A->>A: discovery_agent picks a supplier with diorama.quote
  Note over A,B: the same request goes to every shortlisted studio (here also Frostbite :62262)
  A->>B: OAW_RPC_REQUEST callTool request_quote {rfq, log_rfq: false}
  B->>B: diorama_designer → scene graph · estimator → $500 · operator renders Three.js
  B-->>A: OAW_RPC_EVENT stream + OAW_RPC_RESPONSE quote
  A->>U: Compare quotes + live 3D blueprints · Choose this quote
  loop up to 3 rounds
    A->>A: negotiator_agent (never above budget)
    A->>B: negotiate_quote {counter}
    B->>B: estimator (never below the 12% floor)
  end
  A->>U: Approve Action? place_order $450 → localhost:62261
  A->>B: confirm_commission {quote_id, price}
  B->>U: Approve Action? lock build slot
  B-->>A: order_id + slot date
```

- **JSON is the source of truth.** Each site's network file (`procurement_hub.network.json`, `diorama_studio.network.json`) holds every agent's instructions and output schema. The runtime loads them from `agent-manifest.json`.
- **Models propose, code enforces.** The studio clamps every scene inside the base, applies the scale rules (1:12, 1:35, 1:64, 1:72 with size limits) and never prices below the 12% floor. The hub never accepts or orders above the budget. When a model's proposal breaks a rule, the stream shows the policy line.
- **Human in the loop.** Every write tool pauses on an **Approve Action?** card that shows the exact JSON payload, the price and the target origin. Writes requested by another site are approved on the site that owns them.
- **Cross-site protocol.** `window.postMessage` with `OAW_RPC_REQUEST` / `OAW_RPC_RESPONSE`, plus `OAW_RPC_EVENT` so the hub shows the studio's agent handoffs live. Origins are checked on both sides. Unknown callers need consent.
- **Global API on both sites:** `window.OpenAgenticWeb = { manifest, run(prompt), callTool(name, args), getState() }`.
- **Each site uses its own model settings.** Your Otari key stays on the origin where you entered it. The supplier never receives it.

## Model settings (both sites)

| Mode | What runs |
| --- | --- |
| **Mozilla Otari Gateway (BYOK)** | `POST {base}/chat/completions` with `Authorization: Bearer <key>` and `response_format: json_object`. Base `https://api.otari.ai/api/v1`, or one click for EU `https://eu.api.otari.ai/api/v1`. **Load my models** lists what your key can use (`GET /models`). If the key is in the other region (421), the error offers a one-click switch. |
| **Gemini Nano (Local On-Device)** | Chrome Prompt API (`window.LanguageModel`, falling back to `window.ai.languageModel`) with `responseConstraint`. If a Chrome build rejects the constraint, it retries with JSON instructions. If Nano is unavailable, it runs **Gemini Nano (Local Sim)**: scripted answers with simulated latency, labeled *simulated* in every trace. |
| **Hybrid Auto** | Nano first. If Nano is unavailable, fails or gives no answer within 25 s, Otari answers. |
| **Demo Mode** | Deterministic agents, no network, no key. The default when Nano isn't available. |

The execution stream tags every model call with its source, for example `[otari • anthropic/claude-haiku-4-5 • 812ms • 640 tok]`, `[nano-local • 410ms • $0.00]` or `[nano-sim • 300ms • simulated • $0.00]`.

## Deploy

```bash
npm run build:pages    # writes docs/ for GitHub Pages (this repo publishes main/docs)
npm run verify:pages   # checks the live sites
npm run build -- --base https://your.host/path/ --out dist   # any other static host
```

The build copies `shared/` into each site, layers `frostbite-studio/` over the studio code, rewrites the localhost URLs in the manifests for the target base, adds `.well-known/agent-manifest.json`, and adds `.nojekyll`. On GitHub Pages all three sites share the `isgudtek.github.io` origin. The postMessage protocol is the same, but for a true cross-origin demo run them locally on two ports or host them on two domains.

## Files

```
dev-server.js                 zero-dependency static server for both ports (CORS *, /shared mount, .well-known alias)
shared/oaw-core.js            providers, agent runtime, approvals, manifest validator, postMessage RPC
shared/oaw-ui.{js,css}        settings modal + status pill, execution stream, approval/consent modals, Manifest Inspector
buyer-hub/                    agent-manifest.json, procurement_hub.network.json, hub-logic.js, app.js, index.html, hub.css
diorama-studio/               agent-manifest.json, diorama_studio.network.json, shop.json, studio-logic.js, scene.js (Three.js r187), app.js
frostbite-studio/             overlay on diorama-studio/: shop.json, agent-manifest.json, frostbite_studio.network.json, shop-theme.css
scripts/build-sites.mjs       static build for any base URL
scripts/verify.mjs            HTTP conformance checks
docs/                         built GitHub Pages output
```

## Devpost submission note

> **Open Agentic Diorama Market** is three independent agentic websites that do business with each other in the browser. A buyer types a commission into the **Procurement Hub**. Its `intake_agent` writes an RFQ, and its `discovery_agent` reads suppliers' public `agent-manifest.json` files and shortlists every studio that publishes `diorama.quote`. The `negotiator_agent` sends the RFQ to **Miniature Worlds** and **Frostbite Miniatures** over a postMessage RPC protocol. Each studio's agents design their own procedural 3D diorama, rendered live in Three.js side by side, and price it from materials and labour hours. The buyer compares the two quotes and 3D blueprints, chooses one, and the hub negotiates with that studio: the studio never goes below its floor, and the buyer never goes above budget. Each site owns its own writes, and every write stops on an **Approve Action?** card showing the exact payload, price and target origin.
>
> **Mozilla Otari** is a first-class provider. Visitors bring their own Otari key (global or EU region), load the models their organization can run, and every agent call goes through Otari's OpenAI-compatible `chat/completions` with JSON mode. Usage tokens are shown per call. **Gemini Nano** runs on the device when no key is set, **Hybrid** runs Nano first with Otari as fallback, and **Demo Mode** lets judges try everything without a key. The sites have no backend and no build step, and the agent prompts and schemas are published as JSON.

## License

MIT, see [LICENSE](LICENSE). All code in this repository was written for this project.

Third-party components, used under their own licenses and not redistributed here:

- [Three.js](https://github.com/mrdoob/three.js) r187 (MIT), loaded at runtime from cdn.jsdelivr.net for the 3D viewport.
- [Mozilla Otari](https://github.com/mozilla-ai/otari) (Apache 2.0) and Chrome's built-in Gemini Nano are called as services; no code from them is included.
- The agent manifests and networks follow the [Minimum Viable Specification for a Worldwide Agentic Web](https://github.com/cognizant-ai-labs/agentic-web/blob/main/docs/worldwide_agentic_web_mvp_spec.md) and the Neuro SAN agent-network data model.
