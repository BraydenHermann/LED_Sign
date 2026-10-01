# Distribution and Packaging Checklist

If this project is packaged for a commercial release, external technical evaluation, or due-diligence review, certain development and personal files must be explicitly excluded from the distribution package.

Do **NOT** delete these files from the primary development repository, as they provide critical development provenance and configuration for localhost execution. Simply exclude them during the packaging step.

## Must Exclude (Secrets and Identity)
These files contain personal identities, OAuth keys, or live calendar session data:
- `server/credentials.json` (Google Cloud OAuth Client Secrets)
- `server/token.json` (Active Google Calendar OAuth user token)
- `.env` (Local environment variables containing client secrets)
- Any files containing explicit hardcoded MAC addresses if added later (though currently parameterized or handled as harmless fixtures).

## Should Exclude (Development Provenance)
These files represent the history of how the protocol was reverse-engineered, tested, and developed. While invaluable for historical provenance, they are unnecessary for a production distribution:
- `scratch/` directory (Contains HCI captures, test iterations, and debug outputs)
- `server/ble_test_*.py` (Various iteration scripts used to determine byte boundaries)
- `server/connect_debug.py`, `server/scan_test.py`, `server/scan_long.py`
- Captured `.txt` logs containing LOY SPACE behavioral logs or packet dumps.
- Experimental image assets (e.g., `test.gif`, `reconstructed.gif`).

## Should Exclude (Build Artifacts)
- `client/node_modules/`
- `server/__pycache__/`
- `build/` (if any local Windows executable builds exist)

## Configuration Notice
A source-code distribution package should **never** contain a `token.json` or `credentials.json` file. The documentation clearly outlines how deployers can inject their own configuration via environment variables or provide their own `credentials.json` for localhost setups.
