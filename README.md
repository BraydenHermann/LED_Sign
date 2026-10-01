# LED Sign Setup

The application is designed primarily for local deployment alongside Bluetooth hardware, with configurable OAuth settings that can also support future hybrid/hosted components.

## Network Configuration

By default, the backend securely binds to `127.0.0.1` and restricts CORS origins to local development and application ports. Exposing the backend to a Local Area Network (LAN) should be an intentional deployment choice.

- **`LED_SIGN_HOST`**: Can be set to override the bind address (e.g., `0.0.0.0` for LAN access).
- **`LED_SIGN_CORS_ORIGINS`**: Can be set to a comma-separated list of permitted frontend origins if the default localhost origins need to be expanded.

## Setup Scenarios

### A. Existing/local development
This is the standard configuration for running the application locally on your machine to communicate with nearby LED signs over Bluetooth.
- **Credentials:** Uses server/credentials.json (downloaded from Google Cloud).
- **Redirect URI:** Defaults to http://localhost:8000/auth/callback.
- **Token Storage:** The user token is saved locally to server/token.json.
- **Action Required:** No migration required. Your existing setup will continue to work seamlessly.

### B. Local installation using environment configuration
This configuration is ideal if you are distributing the app (e.g., as a desktop application) and want to use your own OAuth client while still running the server locally.
- **Credentials:** Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET environment variables.
- **Redirect URI:** Defaults to http://localhost:8000/auth/callback (you must add this as an authorized redirect URI in your Google Cloud OAuth client).
- **Token Storage:** The user token is saved locally to the default server/token.json or to the path specified in GOOGLE_TOKEN_PATH.

### C. Hosted/production deployment (Future/Hybrid Architecture)
This configuration applies if parts of the application (such as Google Calendar syncing or user management) are deployed to a centralized cloud server.
- **Local Bluetooth Requirement:** The application communicates with physical LED signs over Bluetooth Low Energy (BLE). Therefore, a backend service or agent *must* run on a machine with local Bluetooth access to the sign. A remote cloud server cannot communicate directly with nearby Bluetooth devices without a local bridge.
- **Credentials:** Set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` environment variables using the deployer's own Google Cloud credentials.
- **Redirect URI:** Set `GOOGLE_REDIRECT_URI` to your hosted deployment's callback URL (e.g., `https://atoto.example.com/auth/callback`). Ensure this exact URI is authorized in your Google Cloud console.
- **Token Storage:** Set `GOOGLE_TOKEN_PATH` to an appropriate persistent storage location for the deployment environment.

---
**Note:** The redirect URI configured in the application (GOOGLE_REDIRECT_URI) must exactly correspond to an authorized redirect URI configured for that OAuth client in Google Cloud.
