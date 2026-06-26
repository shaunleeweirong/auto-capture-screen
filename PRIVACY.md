# Guidely — Privacy Policy

_Last updated: 2026-06-26_

Guidely is a Chrome extension that records on-screen steps into a guide you can
export as a PDF. **Your privacy is the default, not a feature.**

## What data Guidely collects

**None is sent anywhere.** Guidely has no servers, no accounts, and no
analytics. Everything it creates stays on your own computer.

When you press **Start recording**, Guidely captures:

- Screenshots of the visible browser tab on each click
- A short text label for the element you clicked (e.g. the button's name)
- The page URL of each step

This information is stored **locally** in your browser using IndexedDB and
`chrome.storage`. It never leaves your device unless **you** choose to export a
PDF and share that file yourself.

## What Guidely does NOT do

- It does **not** transmit your screenshots, clicks, or any other data to us or
  to any third party.
- It does **not** track your browsing.
- It does **not** record continuously — capture only happens between
  **Start recording** and **Stop**.
- It does **not** capture keystrokes or the contents of password fields.

## Permissions and why they're used

- **activeTab** – take a screenshot of, and inject the recorder into, the tab
  you are actively recording. Granted only when you click the Guidely icon.
- **scripting** – inject the click-recorder script into the page when you start
  recording.
- **storage / unlimitedStorage** – save your guides and screenshots locally so
  they persist between sessions and aren't evicted by the browser.
- **sidePanel** – show the Start/Stop recording controls.

Guidely intentionally requests **no broad host permissions**, so it cannot read
or change data on websites in the background.

## Deleting your data

Delete any guide from the Guidely editor (the ✕ button), or remove all data by
uninstalling the extension. There is no cloud copy to delete.

## Contact

Built by Shaun Lee Wei Rong. Questions: shaunleeweirong@gmail.com
