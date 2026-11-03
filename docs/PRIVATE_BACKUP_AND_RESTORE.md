# Private backup and restore procedure (proposed 2026-10-28; corrected and extended 2026-11-02; NOT yet carried out)

**Status: a procedure and an inventory, written for the founder to approve. Nothing in it has been run, no private file was opened to write it, and no key or secret appears here or may ever appear in this repository (it is public).** GitHub already preserves the code and these documents. It cannot and must not hold the private material below. Locations use `%USERPROFILE%` and project-relative paths on purpose: nothing machine-specific or secret is recorded in this file.

## 0. Update 2026-11-02: the approved direction, and what is still open (documentation only)

**Approved direction (founder).** Back up the private material to **two encrypted destinations: (a) an encrypted copy in a cloud account the founder controls, and (b) an encrypted copy on an external USB drive kept apart from the computer.** Both receive the same archive, and the archive is encrypted **before it leaves the computer**, so neither the cloud provider nor a lost drive exposes content. Nothing in this file has been carried out: no backup was made, no private file was opened or decrypted to write this update, and no script was run.

**What changed since 2026-10-28.** The project is now ONE residential-cleaning AI agent (roadmap 5a-52). Since the first version of this file the private material grew: the Jobber private folder, the consent evidence, the fast-test configuration and its backups, and a set of private PowerShell scripts (section 2a). Several of them are protected by **Windows DPAPI for the current user on this computer** and are unreadable anywhere else (section 4a). That makes a plain file copy of them useless for disaster recovery.

**Design principles used for the 2026-11-02 correction (first principles).** (1) *Recoverability first:* a backup counts only after a restore has succeeded on a different path or profile, and the tool that restores must not depend on the lost computer (section 5d). (2) *Back up only what cannot be rebuilt:* everything that can be re-entered or re-issued from a provider console is rebuilt, not exported, so the number of risky export scripts is as small as possible (section 2b). (3) *Minimum complexity:* one archive, two destinations, one restore procedure; no sync client watching live files; no plaintext working copy outside a non-synced folder. (4) *Independent verification:* the check of a backup must not use only the code that made it (section 5d). (5) *Say what is unverified* (section 8a).

**Cloud destination: OneDrive Personal is PROPOSED, not yet approved** (section 5b). **USB destination: external drive, approved in principle** (section 5c).

**Decisions still needed before anything is built or run: section 8.** Until section 8 is decided and a restore test has passed, **no private record has a verified backup**.

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
| 9 | Restart helper | `%USERPROFILE%\founder-call-backups\start-voice-server.ps1` | [Older helper. The current fast-test start procedure is `fast-test-start.ps1`: eight checks, texts OFF; see item 24.] Starts the OpenAI voice server: loads the contact key from item 3, recomputes the two approval digests, checks that six items are present without printing any, then starts. Holds no secret | Yes (see section 6) | Yes |
| 10 | Paused GPT-Live work | `C:\dev\preserved-work\gpt-live-consent-2026-10-28\` (full copies, a patch against commit `14341ae`, a README) | The unfinished, untested consent work. Not on GitHub | No | **Yes** |
| 11 | Rollback notes | `C:\dev\preserved-work\config-backups\` | The pre-tunnel configuration copy and a redacted TwiML Bin rollback note | No | Yes (private) |
| 12 | API key, Twilio token, live switch | The founder's credential-holding PowerShell window only | Never stored in a file | Re-issued from the provider consoles | **Never back up** |
| 13 | TwiML Bin and number routing | Twilio console (cloud) | The voice route; the Bin holds the private stream address | Re-created from item 4 | A redacted note exists (item 11); the Bin text itself only inside the encrypted archive |
| 14 | Tunnel address | Ephemeral Cloudflare quick tunnel | A new address each start | Yes | No (a lost tunnel means a new address in items 4 and 13) |
| 15 | Dependencies | `node_modules/` | Installed from `package-lock.json` | Yes (`npm ci`) | No |
| 16 | Code and documents | GitHub, `origin/main` | Everything tracked | Yes | Preserved; the new workflow also runs the tests on every push |

### 2a. Inventory additions (2026-11-02; names and roles only; no content was read or decrypted)

| # | Item | Where | What it is | Rebuildable? | Backup route |
|---|---|---|---|---|---|
| 17 | Jobber app credentials | `%USERPROFILE%\.drew-jobber\credentials.enc` | The Jobber app's client id and secret, DPAPI-protected (current user, this computer) | Yes: re-enter from the Jobber developer console | Re-enter (default); a wrapped export only if the founder chooses (section 4a) |
| 18 | Jobber OAuth tokens | `%USERPROFILE%\.drew-jobber\tokens.enc` | Access and refresh tokens (rotated on each refresh), DPAPI-protected | Yes: re-authorize | **Never back up** (a stale refresh token is useless and sensitive); re-authorize after a restore |
| 19 | Approved test numbers and Twilio account id | `%USERPROFILE%\.drew-jobber\test-numbers.enc` | The customer and owner test numbers and the Twilio account id, DPAPI-protected | Yes: re-enter with the setup script | Re-enter (default); wrapped export optional |
| 20 | **Text-consent evidence** | `%USERPROFILE%\.drew-jobber\consent-evidence.enc` | The owner's setup consent and each caller's spoken consent: time, wording version, answer, method, opaque reference (no numbers or names), DPAPI-protected | **No** | **Yes. Needs a decrypt-and-re-wrap export (section 4a), because a plain copy cannot be opened on another profile or computer** |
| 21 | Booking ledger (does not exist yet) | `%USERPROFILE%\.drew-jobber\jobber-booking-ledger.enc` | Duplicate-prevention state: ids only, DPAPI-protected. Jobber's own marker search is a second line of defense | Partly | Same route as item 20, once it exists |
| 22 | Fast-test configuration backups | `poc/intake-runner/*.before-fast-test-*.bak.json` (two files; git-ignored by `.gitignore`) | The call and voice configurations as they were before the fast test was applied (they include the private stream path) | No | Yes (private; encrypted at step 4) |
| 23 | Current configurations (changed) | `poc/intake-runner/founder-voice-call.config.json` and `founder-voice.config.json` | Items 4 and 5 now also hold the fast-test settings (greeting, hours, duration, price, standing approval) and are part of the approval digests | Partly | Yes |
| 24 | Private setup and start scripts | `%USERPROFILE%\founder-call-backups\` : `fast-test-apply-config.ps1`, `fast-test-enter-numbers.ps1`, `fast-test-owner-consent.ps1`, `fast-test-sms-check.ps1`, `fast-test-start.ps1`, `jobber-enter-credentials.ps1`, `set-twilio-token.ps1`, `set-voice-keys.ps1`, `start-voice-server.ps1` | The founder's private helpers. They hold no secret (they prompt privately) but embed machine paths and the Twilio account id | Mostly (they can be rewritten from the roadmap records) | Yes (small) |
| 25 | Public-site files and the Pages repository | `public-site/` (untracked in the main repository) and the local clone `C:\dev\intake-developer-test-site\` (its GitHub copy is public) | The public privacy policy and SMS terms; the clone has local page edits that were not pushed when this was written | Yes (public content) | Not private; push or copy so the edits are not lost |
| 26 | Voice log growth | `poc/intake-runner/founder-voice.log` | The only live-call evidence for the Jack call and later calls; fixed codes and counts only | No | Yes (item 7; it keeps growing) |
| 27 | Old running server's state | The running voice process | **UNVERIFIED claim:** that it holds nothing that is not in the files above (its memory was never inspected; do not inspect it) | n/a | No |

**Never back up (unchanged):** the OpenAI, ElevenLabs and Twilio keys and tokens, the Jobber OAuth tokens (item 18), `node_modules/`, and the ephemeral tunnel address. They are re-issued or reinstalled.

### 2b. Minimum-complexity classification (2026-11-02): what is exported, what is copied, what is rebuilt

| Class | Items | Handling | Why |
|---|---|---|---|
| **Plain files, copied into the encrypted archive** | 1, 2 (by snapshot, section 3), 4 to 8, 10, 11, 22, 23, 24, 26 | Copied as files; the archive's passphrase encryption is the protection | Not DPAPI-bound; some are private (stream path, configs) |
| **DPAPI-bound and NOT rebuildable: exported through one approved wrap-and-restore route** | 20 (consent evidence), 21 (booking ledger, once it exists), and 3 (contact key) only if contacts must survive | Unwrapped in the founder's session in memory only, immediately re-encrypted with a passphrase-derived key, written as one file into the archive; restore re-protects with DPAPI | These cannot be re-entered or re-issued |
| **DPAPI-bound and rebuildable: NOT exported** | 17 (Jobber credentials), 19 (test numbers), 18 (Jobber tokens) | Re-enter or re-issue after a restore (section 5, recovery order) | Exporting them adds secret-handling code for no recoverability gain |
| **Never** | provider keys and tokens, `node_modules/`, the tunnel address | Re-issued or reinstalled | Section 2a |

**Why this is the smaller design.** One export script (for items 20 and 21, plus 3 if chosen) instead of one per file; every secret that can be re-issued stays out of the archive; the archive holds the consent evidence, which is the only irreplaceable DPAPI-bound item.

## 3. A consistent copy of the SQLite databases

The two databases run in write-ahead mode: the live data is split across the main file and its `-wal` file, so **copying only the `.sqlite` file of a running server can lose recent records or produce a damaged copy**. Two safe ways:

- **While the server runs (recommended): a transaction-consistent snapshot with SQLite's own `VACUUM INTO`** (built into `node:sqlite`; no install). Open the source read-only, run `VACUUM INTO '<destination file>'`, then verify the copy: `PRAGMA integrity_check` returns `ok` and the row counts of the copy equal the source's. The server is not stopped; readers and writers are only briefly serialised. This opens the private files read-only and reads counts only, never row contents.
- **With the server stopped:** stop it with Ctrl+C in its window (a clean stop checkpoints the log), then copy the `.sqlite`, `-wal` and `-shm` files **together** as one set. A copy of the `.sqlite` file alone is never accepted.

Never back up by copying the files of a running server, by a cloud-sync client watching the folder, or by a file-level snapshot that does not understand SQLite.

## 4. The contact key: why it needs its own recovery route

`contact-key.dpapi` is protected by Windows DPAPI at the current-user level. It can be unwrapped only by the same Windows user on the same computer. A copy of that file on a USB drive, in the cloud or on a new computer is **not recoverable**, so the encrypted contacts database depends on one machine and one profile. Options, to be chosen by the founder:

1. **A passphrase-wrapped recovery export (recommended if contacts must survive a disaster).** One time, in the founder's own session, a small script unwraps the key in memory and immediately writes it back out encrypted with a strong passphrase (a standard key-derivation function and authenticated encryption; **which tool provides it is UNVERIFIED**: the earlier claim that the needed classes are already in Windows PowerShell is not established, and Node 24's built-in `scrypt` and AES-256-GCM are a candidate, section 8). **The raw key is never written to disk, printed or sent anywhere; no unencrypted key export is ever created.** The wrapped file goes into the encrypted archive and a second offline location; the passphrase is kept in the founder's password manager, **never in the same place as the archive**. A restore reverses it, then re-wraps with DPAPI on the new profile. This script does not exist yet and is new code that needs its own approval.
2. **Accept the loss.** The contacts are synthetic test data with a 30-day retention. If the machine is lost, generate a new key (`contact:lookup --new-key`) and start a fresh contacts database; nothing real is lost today. This stops being acceptable once real customers are involved (and contact handling then needs the production hardening in `docs/PRODUCT_CONTINUITY.md` section 4 anyway).

### 4a. DPAPI recovery risks beyond the contact key (2026-11-02)

**Facts (from the code).** `jobber-dpapi.ts` protects the Jobber files with `ConvertFrom-SecureString` **without a key**: current Windows user, this computer. The contact key file has the same scope. Another user, another computer, or a rebuilt Windows profile **cannot** unprotect them.

**Risks.**
1. **A file copy of any `.enc` file or `contact-key.dpapi` is not a backup** for disaster recovery: it restores only on this profile of this computer.
2. **DPAPI itself can orphan the data**: losing or rebuilding the Windows profile, a forced password reset on some account types, or a reinstall can make the protected blobs permanently unreadable even on the same computer. (Unverified here which of these applies to this machine's account type.)
3. **The consent evidence (item 20) is the one item that cannot be rebuilt.** The Jobber credentials, test numbers and OAuth tokens can be re-entered or re-issued; consent evidence and the booking ledger cannot.
4. **Any export route is itself a risk.** Unwrapping a DPAPI blob puts plaintext in memory in the founder's own session. The constraints for every export are: the plaintext is **never written to disk, printed, logged or sent**; it is immediately re-encrypted with a key derived from a strong passphrase (a standard password-based key-derivation function and an authenticated cipher); the output file is the only thing written; a restore reverses it and re-protects with DPAPI on the new profile; the passphrase is never stored with the archive. **No such script exists; each one is new code that needs the founder's approval, a review and tests against disposable test data before it ever touches a real file.**
5. **Tool availability is unverified.** The earlier text assumed the needed classes are "already in Windows". Windows PowerShell 5.1 runs on the older .NET Framework, which I have **not** verified provides an authenticated cipher class. Node 24 (already required by this project) has `scrypt` and AES-256-GCM built in; that is a candidate that needs no install, but it is a candidate only.
6. **Do not rely on drive encryption.** The earlier finding stands: this machine runs Windows 11 Home, and BitLocker presence was not checked.

## 5. The procedure (run after every live test session, and before any change to the approved configuration)

**Before the first run, the founder decides:** the off-machine destination and who controls it; the passphrase and where it is kept; how many copies to keep (suggestion: the last five plus one a month); whether item 3 uses option 1 or 2.

1. **Snapshot the databases** (section 3) into a new dated working folder **outside the repository and outside every synced folder (section 5b: for example `C:\dev\backup-work\<date>`, which is not under OneDrive; Documents and Desktop are NOT acceptable because they sync)**.
2. **Copy the files that are plain files**: items 4 to 8, 10, 11, 22, 23, 24 and 26, and the text of the TwiML Bin only if the founder pastes it into the folder (it holds the private stream address). **Then run the one approved wrap-and-restore export for the DPAPI-bound, non-rebuildable items (20 and 21, and 3 only if chosen; section 2b): its output file goes into the same folder; no plaintext copy of those items is ever written.** The server need not stop for any of this.
3. **Write a manifest**: the SHA-256 of every file in the folder (`Get-FileHash`), the date, the commit the code was at (`git rev-parse HEAD`) and the server's start time. The manifest holds names and hashes only.
4. **Encrypt the whole folder into one archive with a passphrase** before it leaves the computer. This needs a tool the founder approves: an archiver the founder already uses, a standard command-line tool, or a small script (the tool is UNDECIDED: section 8, decision 1; the earlier claim that .NET alone, with no install, is enough is UNVERIFIED). **Do not rely on drive encryption.** (An earlier version of this file said Windows 11 Home has no BitLocker. That is **not established**: whether BitLocker or Device Encryption is available or on for this machine was never checked, and the archive is encrypted by its own passphrase either way, so nothing here depends on the answer.)
5. **Copy the encrypted archive to the destination(s)**: one off-machine location, one kept offline (a drive stored apart). Delete the unencrypted working folder.
6. **Prove it once, and then each month: a restore test.** Decrypt a copy into a scratch folder (ideally on another computer or user profile), check every hash against the manifest, open each database read-only and confirm `integrity_check` is `ok` and the row counts match the manifest's, and unwrap a **disposable test key** (never the real one) through the same wrapped-export path to prove the key route works. Record the date and the pass or fail (never the content) in `docs/DEVELOPMENT_ROADMAP.md`.
7. **Retention and disposal:** delete archives beyond the retention count; delete the scratch folder after each test. The contacts in a restored database expire on their original 30-day clock (do not extend it).

**Recovery order after losing the computer:** (1) reinstall Node 24 and clone `origin/main`; `npm ci`. (2) Fetch the archive from the USB drive or OneDrive, **decrypt it into a non-synced scratch folder** and check every hash against the manifest. (3) Restore items 4 to 8 into `poc/intake-runner/` and the private scripts (item 24) into `%USERPROFILE%\founder-call-backups\`. (4) Restore the databases (items 1 and 2) and open them read-only to check `integrity_check`. (5) Restore the contact key through route 1 of section 4 (or generate a new one, route 2). (6) **Restore the consent evidence and the booking ledger (items 20 and 21) through the import half of the wrap-and-restore route, which re-protects them with DPAPI on the new profile. If the evidence cannot be restored, the owner's setup consent must be recorded again (`fast-test-owner-consent.ps1`) before any text can be sent, and earlier caller consents are lost.** (7) Re-issue the OpenAI, ElevenLabs and Twilio keys from the provider consoles. (8) **Re-enter the Jobber app credentials (`jobber-enter-credentials.ps1`), re-authorize the Jobber connector (a new token; the old tokens are never restored), and re-enter the approved test numbers (`fast-test-enter-numbers.ps1`).** (9) Start a new tunnel; put the new host into item 4 and the TwiML Bin. (10) Run `fast-test-start.ps1` in its check-only mode: every line True and the gate "all checks pass" is the readiness proof. None of this places a call, books or sends a text, or changes Twilio by itself.

### 5a. The two destinations (approved direction; nothing set up)

| | Cloud copy | External USB copy |
|---|---|---|
| Content | The same encrypted archive and its manifest | The same encrypted archive and its manifest |
| Encryption | Before upload, with the founder's passphrase; the provider never holds the passphrase or a readable file | Before it is written; the drive holds only the encrypted archive |
| Access | An account the founder controls with two-step sign-in; no shared folders; no sync client watching the live working folder | Kept apart from the computer (a different room or place); not left plugged in |
| Failure it covers | Theft, fire, disk failure, ransomware, a lost Windows profile | The cloud account being locked, closed or breached; no internet during recovery |
| Failure it does not cover | A lost or forgotten passphrase (every copy becomes unreadable) | The drive being lost with no cloud copy |
| Retention | The last five plus one a month (suggested) | The same, rotated |
| Verification | A restore test from this copy, then monthly | A restore test from this copy, then monthly |

**Rules for both.** Never upload or copy an unencrypted working folder; delete it after the archive is made. Never put the passphrase, the key material or the manifest's hashes of secrets in the same place as the archive. A cloud provider's own encryption is **not** a substitute for encrypting first.

### 5b. OneDrive Personal as the cloud destination (PROPOSED; synced-folder restrictions)

**Status: proposed by the founder, not yet approved or set up. Facts observed 2026-11-02 (metadata only, no private file touched):** the OneDrive client is installed and running; a **Personal** account is signed in with a sync folder; a Business entry exists with no sync folder and is not to be used; **Documents and Desktop are redirected into OneDrive (Known Folder Move)**; the private locations (`C:\dev`, the repository, `%USERPROFILE%\founder-call-backups`, `%USERPROFILE%\.drew-jobber`) are **not** inside the OneDrive folder, so nothing private syncs today.

**Restrictions (rules, not suggestions).**
1. **Only the final encrypted archive may ever enter a synced folder.** The unencrypted working folder, any plaintext export, the scratch folder of a restore test and the private files themselves are never placed under OneDrive, Documents or Desktop.
2. The unencrypted working and scratch folders live at a **non-synced** path outside the repository (proposed `C:\dev\backup-work\<date>`; `C:\dev` was verified not under the OneDrive folder) and are deleted after use.
3. **Never** enable Known Folder Move or "back up this folder" for `C:\dev`, the repository, `founder-call-backups` or `.drew-jobber`; never move them into Documents, Desktop or the OneDrive folder.
4. Name the archive neutrally (a date and a counter): **no** "drew", "jobber", "consent" or "private" in file or folder names, because OneDrive sees names, sizes and dates.
5. Keep the passphrase, the key material and the manifest out of OneDrive; the manifest is inside the encrypted archive.
6. After copying, **wait until OneDrive reports the file fully synced**, then verify by downloading it again (from another device, a browser session, or another profile) and comparing its SHA-256 with the local archive's. A "synced" icon alone is not verification.
7. Re-check periodically, read-only, that no private path has come under the OneDrive root (the prefix check done on 2026-11-02).

**UNVERIFIED about OneDrive Personal (to be checked by the founder before approving it):** that two-step sign-in is on for this Microsoft account; the storage quota and plan; how many file versions are kept and for how long, and whether the founder can delete old versions and see sign-in activity; that the account's recovery does not depend only on an email the same person could lose; whether any other app or device auto-uploads into it; and that deleting a file removes it as the founder expects. OneDrive's own encryption is **not** a substitute for encrypting the archive first.

### 5c. External USB drive (approved in principle)

1. The drive holds **only the encrypted archive** (and a plain-text README with no secret: what the file is, the restore steps, where the passphrase is kept, **not** the passphrase). Total private inventory measured 2026-11-02 is about 1.2 MB; **capacity is not a constraint, reliability is.**
2. **Two drives, alternated,** are recommended (a single drive is a single point of failure); keep at least one apart from the computer (a different room or place), not left plugged in.
3. After copying, compare the file's SHA-256 with the local archive's; then eject. Run the restore test **from the USB copy** at least once (section 5d).
4. Replace each drive on a schedule the founder chooses (suggest yearly) or when it errors; wipe retired drives.
5. A USB drive can be lost or stolen: its safety rests entirely on the archive passphrase.

### 5d. Verification design: independent, and restorable without the lost machine

1. **The restore tool must not depend on the lost computer.** Whatever creates the archive, the program and a written description of its format (algorithm, key derivation parameters, file layout) must be stored somewhere that survives: the encrypt, decrypt and wrap tools are secret-free and belong in the public repository (the passphrase never does), or the archive uses a standard format that a common third-party tool opens. **A backup that only a script on the lost computer can open is not a backup.**
2. **Independent checks, not only the creating code:** (a) `Get-FileHash` (SHA-256) against the manifest; (b) `PRAGMA integrity_check` and row counts on the restored databases via `node:sqlite` opened read-only; (c) a disposable test key and a disposable test consent record round-trip through the wrap-and-restore route; (d) the archive's own SHA-256 matches after copying to each destination and after downloading from OneDrive.
3. **Restore test environment:** a different Windows user profile at minimum, ideally a different computer, with the scratch folder outside every synced folder. A test on the same profile does not prove DPAPI recovery.
4. **Pass or fail is recorded** (date, source: USB or OneDrive, result, never content) in `docs/DEVELOPMENT_ROADMAP.md`. **Until a restore passes from each destination, that destination is unverified.**
5. **Recovery objectives (proposed):** back up after every live test session and before any change to the approved configuration; a full restore should be doable in about an hour from the written steps.

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
| The wrap-and-restore export of items 20, 21 (and 3) | The items are unwrapped **in memory only** in the founder's session | None | Write, review and test on disposable data first; approve; run it yourself; choose the passphrase |
| Placing the archive in OneDrive Personal | Copies only the final encrypted archive into a synced folder | None | Approve OneDrive as the destination after the checks in section 5b; place it yourself |
| Copying to the USB drive | Copies only the encrypted archive | None | Choose and hold the drive |
| Restore test (each destination) | Decrypts into a non-synced scratch folder in another profile | None | Run it; record pass or fail |

## 7. Findings behind this file (2026-10-28, names and sizes only)

- The two databases, the configurations and the logs exist once, on this computer, and are not covered by any copy outside it.
- `%USERPROFILE%\founder-call-backups` and `C:\dev\preserved-work` hold the only copies of the older configurations, the restart helper, the DPAPI key file and the paused GPT-Live work, all on the same computer.
- No restore has ever been tested. Whether `C:\dev` is covered by any cloud sync could not be seen from here.

## 8. Decisions still needed before any backup is built or run (2026-11-02)

| # | Decision | Options and facts | Needed from |
|---|---|---|---|
| 1 | **Encryption tool** | Principle: a **standard, well-known format** that a second tool can open beats custom code (fewer places for a bug, and the archive stays openable if our script is lost). Candidates: (a) an archiver the founder already uses with AES-256 and **encrypted file names** (for example 7-Zip with header encryption): needs an install if absent, and its settings must be checked; (b) a command-line tool such as `age` or GnuPG: install needed; (c) a small Node script using the built-in `scrypt` and AES-256-GCM: no install, but it is new code (approval, review and tests on disposable data, and its format document and script must live in the public repository, section 5d). **The DPAPI wrap-and-restore export (items 20, 21, 3) needs code regardless of which archive tool is chosen**; the minimum design is one script (section 2b). **Not recommended: relying on drive encryption (its availability here is unverified), a cloud provider's own encryption, or any tool that writes plaintext to disk while working.** Which one is **undecided**. | Founder |
| 2 | **Cloud destination** | **OneDrive Personal is PROPOSED** (installed and signed in; section 5b). Approval needs the founder to confirm the UNVERIFIED items in section 5b (two-step sign-in, quota, version history and deletion, account recovery) and to accept the synced-folder restrictions. If OneDrive is not approved, another account the founder controls with the same properties is the alternative. | Founder |
| 3 | **Passphrase** | Length and form (a long passphrase of several unrelated words is the usual advice), where it is kept (a password manager, plus an offline written copy kept apart from both archives), who else, if anyone, can recover it, and the rule that **losing it makes every copy permanently unreadable**. It must never be stored with an archive or typed into a chat. | Founder |
| 4 | **External USB drive** | Which drive(s), who holds them, where they are kept apart from the computer, and the rotation (two drives alternating is recommended, section 5c). Size is not a constraint (the inventory is about 1.2 MB). | Founder |
| 5 | **Restore test** | Where it runs (a different Windows profile at minimum; a different computer is the real test), how often (after the first backup, then monthly and after any change to the private configuration), the pass criteria in section 5d (hashes, integrity checks, test-key and test-consent round trip, downloaded-copy hash), who runs it, and where the result is recorded (pass or fail and the date only). **Until a restore passes from each destination (USB and OneDrive), that destination counts as unverified.** | Founder |
| 6 | **Scope of the DPAPI-bound items** | **Recommended minimum (section 2b):** export items 20 (consent evidence) and 21 (ledger, once it exists) through one wrap-and-restore route; export item 3 (contact key) only if contacts must survive (they are synthetic test data today); **do not export** items 17, 19 or 18 (re-enter, re-enter, re-authorize). | Founder |
| 7 | **Script approval** | Each export or archive script is new code: written, reviewed and tested on disposable data first; none exists. | Founder, per script |
| 8 | **Timing and trigger** | After every live test session and before any change to the approved configuration (section 5), plus once before the first live fast-test call. Whether the server must be stopped (only for the file-copy route; the snapshot route needs no stop). | Founder |
| 9 | **Retention and disposal** | The count (the last five plus one a month is suggested), and when old archives and the scratch folder are deleted. | Founder |
| 10 | **Items 25 and 10** | Whether to push the Pages repository's local edits (public content) and whether to put the paused GPT-Live work on a private branch (this repository is public, so a public branch would publish unfinished code). | Founder |
| 11 | **Working-folder location** | Proposed non-synced `C:\dev\backup-work\<date>` (outside the repository, not under OneDrive: verified 2026-11-02). Never Documents or Desktop. | Founder |
| 12 | **Where the encrypt, decrypt and wrap tools and the format description live** | Proposed: the public repository (secret-free), so recovery does not depend on the lost computer (section 5d). The passphrase never goes there. | Founder |

### 8a. Claims in this document that are UNVERIFIED (2026-11-02)

- Whether BitLocker or Device Encryption is available or on for this computer (an earlier statement that Windows 11 Home has no BitLocker is not established).
- That a standard authenticated cipher is available in Windows PowerShell 5.1 (the earlier "already in Windows" claim).
- Which Windows events would orphan the DPAPI data for this account type (profile rebuild, password reset, reinstall).
- Everything listed as unverified about OneDrive Personal in section 5b.
- That the running voice server holds nothing not in the files (item 27).
- That each export, archive and restore script works: none exists, none has been tested.
- That a full restore can be done in about an hour: never timed.
- The sizes in the inventory are file sizes measured on 2026-11-02 and will grow (the voice log grows with every call).

## 9. What this update did and did not do

- **Did:** recorded the approved two-destination direction (OneDrive Personal proposed, a USB drive), added the missing private items (17 to 27), classified every item by the minimum handling that recovers it (section 2b), described the DPAPI recovery risks and the Jobber and consent recovery steps, added the synced-folder restrictions and the independent verification design, corrected the contradictions found 2026-11-02 (BitLocker, "already in Windows", the older start helper, the unverified item 27, the procedure and recovery order that ignored the new items), and listed the open decisions and the unverified claims.
- **Did not:** make a backup, open or decrypt any `.enc` or key file, run a script, choose a tool or provider, or write any application or backup code. Section 7's findings are unchanged; the current disk state they describe has grown (section 2a).
