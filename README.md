# BYO LLM — Experience Workspace plugin

An Edge Delivery Services / Experience Workspace plugin that generates or rewrites page content with your organisation’s own LLM. Authors select a block or text, describe what to do, optionally attach context files, and insert the result back into the document.

Plugin files live in [`tools/byo-llm/`](tools/byo-llm/).

## Environments

- Preview: https://main--byo-llm-plugin--LegoKam.aem.page/
- Live: https://main--byo-llm-plugin--LegoKam.aem.live/

Replace `LegoKam` / `byo-llm-plugin` with your org and site names if this repo was forked.

## What you get

- **Generate from selection** — works on default content or an EDS block (hero, cards, columns, …)
- **Block-aware scope** — Auto / Text / Assets / Both (text updates leave images alone; assets updates focus on alt text)
- **File attachments** — text, Markdown, CSV, JSON, HTML, PDF, or images as context
- **Org-wide settings** — provider, endpoint, model, and API key stored in the organisation’s da.live `secrets` sheet

Supported providers: OpenAI-compatible (OpenAI, Gemini gateways, Ollama, LiteLLM, …), Azure OpenAI, and Anthropic. Calls go from the browser to the endpoint; the endpoint must allow browser CORS.

## Install

### 1. Clone and run locally

```sh
git clone https://github.com/LegoKam/byo-llm-plugin.git
cd byo-llm-plugin
npm i
npx -y @adobe/aem-cli up
```

The site is at `http://localhost:3000`. The plugin page is:

`http://localhost:3000/tools/byo-llm/byo-llm.html`

### 2. Register the plugin in da.live

1. Open the site config: [da.live/config#/legokam/byo-llm-plugin/](https://da.live/config#/legokam/byo-llm-plugin/)
2. Open the **library** sheet (create it if it does not exist).
3. Add a row:

   | title   | path                                   | ref   |
   | ------- | -------------------------------------- | ----- |
   | BYO LLM | `/tools/byo-llm/byo-llm.html`          |       |

   For **local development** before the code is on `main`, use:

   | title   | path                                                 | ref   |
   | ------- | ---------------------------------------------------- | ----- |
   | BYO LLM | `http://localhost:3000/tools/byo-llm/byo-llm.html`   | local |

4. Save the config.

### 3. Open Experience Workspace

- Local plugin: [da.live/canvas?ref=local#/legokam/byo-llm-plugin/index](https://da.live/canvas?ref=local#/legokam/byo-llm-plugin/index)
- Shipped plugin (after merge to `main`): [da.live/canvas#/legokam/byo-llm-plugin/index](https://da.live/canvas#/legokam/byo-llm-plugin/index)

Open **Panels → Extensions → BYO LLM**.

`ref=local` only loads rows whose library `ref` is `local` (or any row when the page ref is `local`). Clear the library `ref` and drop `?ref=local` once the plugin is served from `main`.

## Configure the LLM

1. In the plugin, open **Settings**.
2. Choose a **Provider**, set **Endpoint** and **Model**, and paste the **API key**.
3. Use **Test connection**, then **Save**.

Settings are written to the organisation config’s **secrets** sheet as:

| key                | example                          |
| ------------------ | -------------------------------- |
| `byo-llm.provider` | `openai`                         |
| `byo-llm.endpoint` | `https://api.openai.com/v1`      |
| `byo-llm.model`    | `gpt-4o-mini`                    |
| `byo-llm.api-key`  | *(your key)*                     |

You can also edit that sheet directly at [da.live/config#/legokam/](https://da.live/config#/legokam/) (org config, **secrets** tab). Header row must be `key` / `value`.

**Security note:** anyone who can read the org config can read the API key. The browser sends the key to the LLM. Prefer a gateway that enforces its own auth if that is not acceptable.

If the config editor tab was already open when you saved from the plugin, reload it before pressing Save there — a stale empty sheet can overwrite the plugin’s rows.

## Use

1. Select a block or text in the document (or leave nothing selected to create new content).
2. For a block, the panel shows the block name and counts (e.g. `cards · 7 text · 7 assets`).
3. Choose a scope if needed: **Auto**, **Text**, **Assets**, or **Both**.
4. Describe what to do, or use a preset (Improve writing, Shorten, Expand, …).
5. Optionally **Attach files** for brand or reference context.
6. **Generate**, review the short summary, then **Replace … block** / **Replace selection** / **Insert**.

**Assets** scope updates image alt text (and can remove images if asked). It does not generate new images.

## Develop

```sh
npx -y @adobe/aem-cli up   # http://localhost:3000
npm run lint
```

| File | Role |
| ---- | ---- |
| `tools/byo-llm/byo-llm.html` | Plugin shell |
| `tools/byo-llm/byo-llm.js` | UI and SDK wiring |
| `tools/byo-llm/byo-llm.css` | Styles |
| `tools/byo-llm/llm.js` | Provider requests and HTML sanitising |
| `tools/byo-llm/block-model.js` | EDS block detection and scope |
| `tools/byo-llm/attachments.js` | File attachment reading |
| `tools/byo-llm/secrets.js` | Read/write org `secrets` sheet |

Useful SDK actions: `getSelection`, `subscribeLiveDocument`, `sendHTML` / `sendHTML(html, { replace: true })`. See [Developing apps & plugins](https://docs.da.live/developers/guides/developing-apps-and-plugins).

## Edge Delivery docs

1. [Developer Tutorial](https://www.aem.live/developer/tutorial)
2. [The Anatomy of a Project](https://www.aem.live/developer/anatomy-of-a-project)
3. [Markup, Sections, Blocks, and Auto Blocking](https://www.aem.live/developer/markup-sections-blocks)
