# 🛡️ WhatsApp Web Privacy Suite
### (Automated Multi-Section Privacy & Contact Exclusion System for WhatsApp Web)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)](#)
[![Python](https://img.shields.io/badge/Python-3776AB?style=flat&logo=python&logoColor=white)](#)
[![Playwright](https://img.shields.io/badge/Playwright-2EAD33?style=flat&logo=playwright&logoColor=white)](#)

This project is an **automated privacy management and contact exclusion suite** for **WhatsApp Web** (`web.whatsapp.com`). Available as both a **zero-install Browser Console Studio UI** and a **Python + Playwright desktop automation tool**, it scans your contacts and synchronizes privacy exclusions across all WhatsApp privacy sections with built-in **Absolute Photo-Guard** protection.

---

## 📚 Table of Contents
- [About the Project](#about-the-project)
- [Features](#features)
- [Technologies Used](#technologies-used)
- [Installation & Usage](#installation--usage)
- [Project Structure](#project-structure)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Disclaimer](#disclaimer)
- [Development Process](#development-process)
- [Contributing](#contributing)
- [Contact](#contact)
- [License](#license)

---

## About the Project
Managing WhatsApp privacy exclusions manually across hundreds of contacts and multiple sections (**Last Seen & Online**, **Profile Photo**, **About**, **Status**, and **Groups**) is tedious and error-prone. This suite automates the entire workflow: it navigates WhatsApp Web's privacy menus safely, detects contacts without visible profile photos (or matching custom privacy criteria), protects contacts who have real profile photos, and synchronizes your exclusion list across every selected section.

- **Developer:** Haluk Can SARIÖZ
- **Version:** v24 Final Studio Edition

---

## Features
- **Absolute Photo-Guard** — 5-layer avatar detection (`<img>`, `<svg><image>`, `<canvas>`, inline & computed `background-image`) with lazy-load settling ensures contacts with real profile photos are never checked.
- **Full Multi-Section Sync** — Automatically iterates through *Last Seen & Online*, *Profile Photo*, *About*, *Status*, and *Groups*, resetting counters per section and confirming (`✓`) each list.
- **Zero-Misclick & Strict Account Shield** — Uses 100% exact title matching and a forbidden-row blacklist so it never clicks *Strict Account Settings*, *Read Receipts*, or *Online* toggles, and auto-dismisses lock pop-ups.
- **7 Smart Exclusion Criteria** — Hide contacts with no profile photo, empty/default *About* text, business accounts, unsaved numbers (`+90...`), foreign country codes, single-character/symbol names, or custom keywords.
- **VIP Whitelist & Blacklist** — Protect family/close contacts from all rules, or force-hide specific contacts with single-click and bulk actions in the Contact Explorer.
- **Modern Studio Dashboard UI** — Glassmorphic draggable floating panel with 6 live KPI cards, stacked distribution bar, 3 themes (*WhatsApp Dark*, *AMOLED*, *Emerald*), **Ghost Transparency Mode**, and **Privacy Blur**.
- **In-Device Self-Test Center** — Verifies core detection, criteria filters, and navigation selectors safely before modifying real settings.
- **Reporting & Auto-Scheduler** — Export results to **CSV**, **HTML**, **TXT**, or **JSON**, copy summaries to clipboard, and schedule periodic automatic re-scans.

---

## Technologies Used
- **JavaScript (ES6+ & DOM API)** — Browser console automation engine, virtual-scroll handler, and glassmorphic Studio UI.
- **Python 3** — Standalone desktop runner, CLI diagnostics, and core rule engine.
- **Playwright** — Persistent Chromium browser automation for hands-free desktop execution.
- **HTML5 & CSS3** — Self-contained interactive reports and glassmorphism interface styling.

---

## Installation & Usage

### Option A: Browser Console Mode (Zero Installation — Fastest)
1. Open [WhatsApp Web](https://web.whatsapp.com/) and sign in.
2. Press **`F12`** (or `Ctrl + Shift + I`) and switch to the **Console** tab.
3. Copy the full contents of `whatsapp_pp_gizlilik_otomasyonu.js`, paste it into the console, and press **`Enter`**.
4. Select your target privacy sections in the floating panel and click **`▶ Tam Otomatik Başlat & Eşitle`**.

### Option B: Desktop Automation (Python + Playwright)

#### 1. Clone the Repository
```bash
git clone https://github.com/halukcansarioz/WhatsApp-Privacy-Suite.git
```

#### 2. Navigate to the Project Directory
```bash
cd WhatsApp-Privacy-Suite
```

#### 3. Install Dependencies
```bash
pip install -r requirements.txt
playwright install chromium
```

#### 4. Launch the Application
To launch the persistent Chromium desktop automation:
```bash
python whatsapp_oto_gizlilik.py
```

To run the built-in core self-test suite in the terminal:
```bash
python whatsapp_oto_gizlilik.py --self-test
```

> ⚠️ **Note:** Never commit or share your local Chromium session profile folder (`wa_session_profile/`) or exported contact reports (`.csv`, `.html`, `.txt`, `.json`). They are excluded automatically via `.gitignore`.

---

## Project Structure
```text
WhatsApp-Privacy-Suite/
├── whatsapp_pp_gizlilik_otomasyonu.js   # Browser console automation & Studio UI (v24)
├── whatsapp_oto_gizlilik.py             # Python + Playwright desktop automation & self-test
├── requirements.txt                     # Python dependencies (Playwright)
├── .gitignore                           # Protects session profiles & personal contact exports
├── LICENSE                              # MIT License
└── README.md                            # Project documentation
```

---

## Keyboard Shortcuts
| Shortcut | Action |
| :--- | :--- |
| `Alt + S` | Start / Stop Automation |
| `Alt + P` | Pause / Resume |
| `Alt + M` | Minimize / Expand Panel |
| `Alt + B` | Toggle Privacy Blur Mask |

---

## Disclaimer
This project is developed solely for **personal use and educational purposes**. It is not affiliated with, endorsed by, or associated with WhatsApp LLC or Meta Platforms, Inc. Use automation tools responsibly and at your own discretion.

---

## Development Process

### 1. Fork the Repository
Start by forking the project to your own GitHub account.

### 2. Create a New Branch
```bash
git checkout -b feature/privacy-improvement
```

### 3. Push Your Code
```bash
git push origin feature/privacy-improvement
```

---

## Contributing
1. **Fork** this repository.
2. Create a **Branch** (`git checkout -b feature/NewFeature`).
3. Make your changes and **Commit** (`git commit -m 'Add: New feature'`).
4. **Push** your code (`git push origin feature/NewFeature`).
5. Open a **Pull Request**.

---

<a name="contact"></a>
## Contact
**Haluk Can Sarıöz**
- GitHub: [@halukcansarioz](https://github.com/halukcansarioz)
- Email: [halukcansarioz19@gmail.com](mailto:halukcansarioz19@gmail.com)
- LinkedIn: [Haluk Can Sarıöz](https://www.linkedin.com/in/halukcansarioz)

**Project Link:** [https://github.com/halukcansarioz/WhatsApp-Privacy-Suite](https://github.com/halukcansarioz/WhatsApp-Privacy-Suite)

---

## License
This project is licensed under the [MIT License](LICENSE).
