# Private backup and restore procedure (proposed 2026-10-28; NOT yet carried out)

**Status: a procedure and an inventory, written for the founder to approve. Nothing in it has been run, no private file was opened to write it, and no key or secret appears here or may ever appear in this repository (it is public).** GitHub already preserves the code and these documents. It cannot and must not hold the private material below. Locations use `%USERPROFILE%` and project-relative paths on purpose: nothing machine-specific or secret is recorded in this file.

## 1. What a same-computer copy is, and is not

A copy kept on the same computer (another folder, the existing `founder-call-backups` folder, a second drive in the same machine) protects against a deleted or overwritten file, and nothing else. It is **not disaster recovery**: theft, a failed disk, a lost Windows profile, ransomware or a fire takes the original and the copy together. Disaster recovery needs an **encrypted copy held somewhere else** (an offline drive kept apart, or an account the founder controls, with encryption done BEFORE upload so the provider never sees the contents) **and a restore that has been tested** on a different folder, and ideally a different user profile or computer. Until section 5 has been done once, no private record has a verified backup.

## 2. Inventory (names and roles only; no content was read)

| # | Item | Where | What it is | Rebuildable? | Needs backup? |
|---|---|---|---|---|---|
| 1 | Intake record database | `poc/intake-runner/founder-call.sqlite` (+ `-wal`, `-shm`) | The saved call records (masked; no raw contact values by design) and the evidence of every live test | No | **Yes** |
| 2 | Encrypted contacts database | `poc/intake-runner/founder-call-contacts.sqlite` (+ `-wal`, `-shm`) | Name, number and address of confirmed callers, encrypted with the contact key, 30-day retention | No (test data, expires) | Yes, only useful together with item 3 |
| 3 | Contact key | `%USERPROFILE%\founder-call-backups\contact-key.dpapi` | The contact key, wrapped by Windows DPAPI for THIS Windows user on THIS computer | **No** | **Yes, by a separate route (section 4)** |
| 4 | Approved call configuration | `poc/intake-runner/founder-voice-call.config.json` | The approved settings, including the private stream path and the approval inputs | Partly (a new path means a new TwiML Bin entry) | **Yes** (private) |
| 5 | Voice settings | `poc/intake-runner/founder-voice.config.json` | Voice, persona and conversation-mode settings | Yes, from the roadmap | Yes (small) |
| 6 | Older route configuration | `poc/intake-runner/founder-call.config.json` | The earlier ConversationRelay route settings (private) | Partly | Yes (private) |
| 7 | Diagnostics logs | `poc/intake-runner/founder-voice.log`, `founder-call.log` | Fixed codes and counts per call (no speech, no contact values); the evidence behind the live results in the roadmap | No | Yes |
| 8 | Configuration history | `%USERPROFILE%\founder-call-backups\*.json` | Older copies of the call configuration | No | Yes (private) |
| 9 | Restart helper | `%USERPROFILE%\founder-call-backups\start-voice-server.ps1` | Starts the OpenAI voice server: loads the contact key from item 3, recomputes the two approval digests, checks that six items are present without printing any, then starts. Holds no secret | Yes (see section 6) | Yes |
| 10 | Paused GPT-Live work | `C:\dev\preserved-work\gpt-live-consent-2026-10-28\` (full copies, a patch against commit `14341ae`, a README) | The unfinished, untested consent work. Not on GitHub | No | **Yes** |
| 11 | Rollback notes | `C:\dev\preserved-work\config-backups\` | The pre-tunnel configuration copy and a redacted TwiML Bin rollback note | No | Yes (private) |
| 12 | API key, Twilio token, live switch | The founder's credential-holding PowerShell window only | Never stored in a file | Re-issued from the provider consoles | **Never back up** |
| 13 | TwiML Bin and number routing | Twilio console (cloud) | The voice route; the Bin holds the private stream address | Re-created from item 4 | A redacted note exists (item 11); the Bin text itself only inside the encrypted archive |
| 14 | Tunnel address | Ephemeral Cloudflare quick tunnel | A new address each start | Yes | No (a lost tunnel means a new address in items 4 and 13) |
| 15 | Dependencies | `node_modules/` | Installed from `package-lock.json` | Yes (`npm ci`) | No |
| 16 | Code and documents | GitHub, `origin/main` | Everything tracked | Yes | Preserved; the new workflow also runs the tests on every push |

## 3. A consistent copy of the SQLite databases

The two databases run in write-ahead mode: the live data is split across the main file and its `-wal` file, so **copying only the `.sqlite` file of a running server can lose recent records or produce a damaged copy**. Two safe ways:

- **While the server runs (recommended): a transaction-consistent snapshot with SQLite's own `VACUUM INTO`** (built into `node:sqlite`; no install). Open the source read-only, run `VACUUM INTO '<destination file>'`, then verify the copy: `PRAGMA integrity_check` returns `ok` and the row counts of the copy equal the source's. The server is not stopped; readers and writers are only briefly serialised. This opens the private files read-only and reads counts only, never row contents.
- **With the server stopped:** stop it with Ctrl+C in its window (a clean stop checkpoints the log), then copy the `.sqlite`, `-wal` and `-shm` files **together** as one set. A copy of the `.sqlite` file alone is never accepted.

Never back up by copying the files of a running server, by a cloud-sync client watching the folder, or by a file-level snapshot that does not understand SQLite.

## 4. The contact key: why it needs its own recovery route

`contact-key.dpapi` is protected by Windows DPAPI at the current-user level. It can be unwrapped only by the same Windows user on the same computer. A copy of that file on a USB drive, in the cloud or on a new computer is **not recoverable**, so the encrypted contacts database depends on one machine and one profile. Options, to be chosen by the founder:

1. **A passphrase-wrapped recovery export (recommended if contacts must survive a disaster).** One time, in the founder's own session, a small script unwraps the key in memory and immediately writes it back out encrypted with a strong passphrase (a standard key-derivation function and authenticated encryption, built from .NET classes already in Windows). **The raw key is never written to disk, printed or sent anywhere; no unencrypted key export is ever created.** The wrapped file goes into the encrypted archive and a second offline location; the passphrase is kept in the founder's password manager, **never in the same place as the archive**. A restore reverses it, then re-wraps with DPAPI on the new profile. This script does not exist yet and is new code that needs its own approval.
2. **Accept the loss.** The contacts are synthetic test data with a 30-day retention. If the machine is lost, generate a new key (`contact:lookup --new-key`) and start a fresh contacts database; nothing real is lost today. This stops being acceptable once real customers are involved (and contact handling then needs the production hardening in `docs/PRODUCT_CONTINUITY.md` section 4 anyway).

## 5. The procedure (run after every live test session, and before any change to the approved configuration)

**Before the first run, the founder decides:** the off-machine destination and who controls it; the passphrase and where it is kept; how many copies to keep (suggestion: the last five plus one a month); whether item 3 uses option 1 or 2.

1. **Snapshot the databases** (section 3) into a new dated working folder outside the repository.
2. **Copy the files that are plain files**: items 4 to 8, 10 and 11, and the text of the TwiML Bin only if the founder pastes it into the folder (it holds the private stream address). The server need not stop for any of this.
3. **Write a manifest**: the SHA-256 of every file in the folder (`Get-FileHash`), the date, the commit the code was at (`git rev-parse HEAD`) and the server's start time. The manifest holds names and hashes only.
4. **Encrypt the whole folder into one archive with a passphrase** before it leaves the computer. This needs a tool the founder approves: a small script using .NET (no install), or an archiver the founder already uses. Windows 11 Home has no BitLocker, so do not rely on drive encryption being present.
5. **Copy the encrypted archive to the destination(s)**: one off-machine location, one kept offline (a drive stored apart). Delete the unencrypted working folder.
6. **Prove it once, and then each month: a restore test.** Decrypt a copy into a scratch folder (ideally on another computer or user profile), check every hash against the manifest, open each database read-only and confirm `integrity_check` is `ok` and the row counts match the manifest's, and unwrap a **disposable test key** (never the real one) through the same wrapped-export path to prove the key route works. Record the date and the pass or fail (never the content) in `docs/DEVELOPMENT_ROADMAP.md`.
7. **Retention and disposal:** delete archives beyond the retention count; delete the scratch folder after each test. The contacts in a restored database expire on their original 30-day clock (do not extend it).

**Recovery order after losing the computer:** reinstall Node 24 and clone `origin/main`; `npm ci`; restore the archive, then items 4 to 8 into `poc/intake-runner/`; restore the key through route 1 of section 4 (or generate a new one, route 2); re-issue the API key and Twilio token from the provider consoles; start a new tunnel; put the new host into item 4 and the TwiML Bin; run the restart helper. None of this places a call or changes Twilio by itself.

## 6. What approval or access each step needs (nothing below has been done)

| Step | Private-file access | Server stop | Founder action |
|---|---|---|---|
| Database snapshots (3, first route) | Read-only open of items 1 and 2; counts only | **None** | Approve; run in the founder's session or grant access |
| Database copy (3, second route) | Copy of items 1 and 2 | **Yes, a clean stop** | Stop and restart the server (the restart is the founder's act) |
| Plain file copies (5 step 2) | Copy of items 4 to 11 (the private ones are encrypted at step 4) | None | Approve |
| Key recovery export (4, route 1) | **The key is unwrapped in the founder's own session, in memory only** | None | Write and approve the script; choose the passphrase; run it |
| Encryption and off-machine copy | None beyond the above | None | Choose the tool, destination and passphrase storage |
| The restart helper copy to the repository | Reads a file that holds no secret | None | Approve (a version with the machine-specific path removed could live in `docs/`) |
| Pushing the paused GPT-Live work to a private branch | None (no secret in it) | None | Only if the founder wants it (this repository is public, so a public branch would publish unfinished code) |

## 7. Findings behind this file (2026-10-28, names and sizes only)

- The two databases, the configurations and the logs exist once, on this computer, and are not covered by any copy outside it.
- `%USERPROFILE%\founder-call-backups` and `C:\dev\preserved-work` hold the only copies of the older configurations, the restart helper, the DPAPI key file and the paused GPT-Live work, all on the same computer.
- No restore has ever been tested. Whether `C:\dev` is covered by any cloud sync could not be seen from here.
