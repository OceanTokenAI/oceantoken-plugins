# OceanToken

The `oceantoken` MCP server gives you 500+ AI models behind the user's OceanToken
account: chat models, image, video, text-to-speech, transcription and
embeddings, billed per use to their prepaid balance.

- If a tool call says the server needs authentication, tell the user to run
  `/mcp auth oceantoken` and sign in with their OceanToken account (or paste an
  API key on the sign-in page).
- Find models with `search_models` and read options with `get_model`. Never
  invent a model id.
- Call `estimate_cost` before video, batches of images, 4K images or long
  speech, and tell the user the figure. Ask before spending more than about $2
  unless they already agreed to a budget.
- `create_video` is asynchronous: poll `get_job` until it completes.
- Results are links that expire in about 24 hours. Download files the project
  needs right away (`curl -L -o <path> "<url>"`).
- Local files a model should see go through `upload_file` first.

The bundled skills `oceantoken-media`, `oceantoken-models` and
`oceantoken-setup` hold the detailed workflows.
