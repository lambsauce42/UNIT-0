# Unit 0 Remote Inference Server

Start this desktop app on the GPU machine, configure the models, then enter that machine's IP address, port, and pairing code in Unit 0.

```powershell
cd remote-inference-server
npx electron desktop-main.js --config config.example.json
```

The desktop app lets you edit the server host, port, pairing code, host identity, and model list. For normal use, add a model with `backend: "llama-server"` and `launchMode: "managed"`, choose the GGUF file, and choose the `llama-server` executable. The server app launches and monitors that llama.cpp process on the GPU machine.

```json
{
  "host": "0.0.0.0",
  "port": 14555,
  "pairingCode": "ABCD-1234",
  "hostIdentity": "gpu-box-01",
  "models": [
    {
      "id": "gpt-oss-gpu",
      "label": "GPT-OSS GPU",
      "reference": "gpt-oss",
      "sourceLabel": "Remote Inference",
      "backend": "llama-server",
      "launchMode": "managed",
      "modelPath": "C:\\Models\\gpt-oss.gguf",
      "binaryPath": "C:\\Unit-0\\runtime\\llama.cpp\\llama-server.exe",
      "runtimeHost": "127.0.0.1",
      "runtimePort": 8080,
      "nCtx": 8192,
      "nGpuLayers": -1,
      "parallelSlots": 1,
      "prewarmOnStart": true,
      "promptFormat": "gpt-oss"
    }
  ]
}
```

Use `launchMode: "external"` only when you intentionally manage `llama-server` yourself and want Unit 0 to proxy to its URL.

The desktop app shows configured models, connected clients, active requests, prepared contexts, and runtime logs. The same runtime status is also available at `http://<gpu-ip>:14555/`.
