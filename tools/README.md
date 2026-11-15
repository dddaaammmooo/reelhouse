# tools/

Helper scripts that aren't part of the app itself.

| File | What it does |
|---|---|
| `make-icon.py` | Draws `icon.png` (512×423, Samsung's TV app-icon size): the Reelhouse wordmark on a dark-navy gradient. Needs Python with Pillow and Windows' Segoe UI fonts. Edit and re-run this rather than editing the PNG. |
| `package-tv.sh` | Signs and packages `Reelhouse.wgt` on Linux, used by the **TV package** GitHub workflow and by `build-tv.sh`. Takes the Samsung certificates and their passwords from environment variables, checks each password opens its certificate, and checks the finished package is signed with your author certificate. The package holds no API keys. |
| `TizenPassword.java` | Used by `package-tv.sh`: encrypts a certificate password the way the Tizen command-line tools expect to find it in a signing profile. Needs a JDK 11 or newer. |

To install on your own TV with your `.env` built in, use [`build-tv.ps1`](../build-tv.ps1) on Windows or [`build-tv.sh`](../build-tv.sh) on Linux; see "Deploy to a Samsung TV" in the [README](../README.md).
