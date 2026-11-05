# Өртөө / RelayLink

App: https://anirkh.github.io/RelayLink/ · Code: https://github.com/AnirKh/RelayLink

## Layout

| File | What it holds |
| --- | --- |
| `tools/sync-build.js` | Stamps the client with a build id so a browser cannot run files from two versions. **Run `npm run sync-build` after changing any file below that a browser loads.** See "One version in the browser at a time". |
| `index.html` | Markup. Loads `framebust.js` first, then `protocol.js`, `connstats.js`, `guards.js`, `i18n.js`, `app.js` **in that order** — `app.js` reads `DCProtocol`, `DCStats`, `DCGuards`, `LANG` and `I18N` while parsing. |
| `protocol.js` | Pure wire-protocol logic: invite links, ECDH→HKDF key derivation, verification code, binary chunk framing. No DOM, no sockets, no state — loaded as `window.DCProtocol` in the browser and `require`d by the tests. |
| `i18n.js` | All user-visible strings, Mongolian and English. Pure data. |
| `guards.js` | The safety decisions as pure functions — may the camera open, may this message be believed, may the microphone open, may this voice note be sent, which room is the server talking about, what the verification shield says. See below. |
| `connstats.js` | Everything derived from an `RTCStatsReport`: which route ICE chose, direct or relayed, link quality, byte totals, and the address each device shows the other. Also the coarse description of a device, and the fixed table of what may be displayed about the other side's. Pure. |
| `pake.js` | SPAKE2 (RFC 9382) over P-256 — the password-authenticated key agreement a **code room** uses, so a short shared word verifies the chat with nothing to compare by hand. Pure; pinned to the RFC test vectors. See "Code rooms". |
| `vendor/noble.js` | The audited elliptic-curve + hashing library `pake.js` stands on (`@noble/curves`, `@noble/hashes`), bundled into one self-hosted file by `npm run build-vendor`. Used unmodified; do not edit by hand. |
| `app.js` | Everything stateful and everything with an effect: WebRTC, data channel, calls, chat UI. Asks the two modules above rather than deciding for itself. |
| `csp.js` | The Content-Security-Policy, defined once (see below). |
| `clientip.js` | Works out the real client address from `X-Forwarded-For`. Every rate limit depends on it, so it is separate and tested. |
| `ratelimit.js` | Sliding-window counters, their expiry sweep, `safeLabel` for anything client-supplied that reaches a log line, and `joinVerdict` — which join lock applies to which credential. Same reason as above: small, pure, security-relevant. |
| `framebust.js` | Refuses to run inside a frame. The only such protection on GitHub Pages (see below). |
| `manifest.webmanifest`, `icons/` | What makes the site installable as an app: its name, colours and icons. `icons/icon.svg` is the drawing; the PNGs are rendered from it. See "Installable as an app". `icons/link-preview-relaylink.png` is the card a shared link shows — see "Link previews". |
| `server.js` | Signaling, PIN/token auth, rate limits, the mailbox and its files, the owner's inbox. |
| `knock.js` | Sending a knock: Web Push to a saved person's device — RFC 8291 encryption (checked against the RFC's own example), VAPID signing, and the push services it may send to. Node's own crypto, no dependency. See "Knocks". |
| `mailbox.js` | Messages, photos and files waiting for a saved person who is away: kept sealed — never read — in a file (the files beside it) or in memory, with their limits and their week. See "Waiting messages". |
| `deploy/pi/` | Running the server — its one home — on a Raspberry Pi behind Tailscale Funnel: the systemd service, an updater and its timer, the settings file, and `SETUP.md`. See "On a Raspberry Pi at home". |
| `sw.js` | The service worker, for knocks only: shows one by the name this device gave the person, and opens the app to them when tapped. Answers no requests, so nothing is ever cached. |

Adding a string means adding it to **both** languages in `i18n.js` — `t()` falls back to the key name, so a missing translation shows up as raw text in the UI.

## Invite links

```
https://host/path#<encoded room name>:<join token>:<room secret>
                  └─ part 0 ─────────┘ └─ part 1 ─┘ └─ part 2 ─┘
```

| Part | Made by | Goes to the server? | Purpose |
| --- | --- | --- | --- |
| room name | the host, typed | **yes** | identifies the room |
| join token | the **server** | **yes** | lets a guest in without typing the PIN |
| room secret | the host's **browser** | **never** | authenticates the key exchange |

Built and parsed only by `buildInviteHash` / `parseInviteHash` in `protocol.js`. The room name is URI-encoded, so a literal `:` becomes `%3A`; the token and secret are base64url. No part can therefore contain a `:`, which is what makes splitting on it unambiguous.

### Why the secret is in the fragment

Everything after `#` in a URL is **never sent in an HTTP request**. The browser keeps it. That is the entire reason it lives there.

Plain ECDH cannot detect a man-in-the-middle: the signalling server relays both public keys and could substitute its own. The room secret is mixed into the key derivation (`deriveSharedKey`), so an attacker who never saw it derives a different key, fails the confirmation exchange, and the channel never opens. Users do nothing — they send the link they were sending anyway.

This only works because the server never learns the secret. **The one rule: never put the room secret in a WebSocket message, a query string, a request body, or a log line.** Of the invite's three parts, only `sessionId` and `token` may go over the wire. (The host key a host sends to take its room back is the server's own secret, which it made and handed out — not the room secret, and never in a link. Nor is the create key a page sends with a create: a random value of its own, only ever sent with that create, so that the same create sent again gets the same room back. A saved person's secret is a room secret like any other: it crosses only the sealed chat, once, and a meet carries the room's name — a hash of it — never the secret. See "Saved people".)

Breaking that rule would remove the protection while everything carried on working, so it is enforced rather than merely documented:

- `wsSend` runs `payloadLeaksSecret` over every outgoing message and **refuses to send** any that contains a secret. Losing one signalling message is recoverable; leaking the secret is not.
- The guard checks `roomSecret`, `pendingRoomSecret` **and** `_autoSecret`. The join is sent while the secret is still in `pendingRoomSecret` — `roomSecret` is only assigned once the server confirms — so checking one variable would leave the guard inert during the very message most likely to carry it.
- `test/client-source.test.js` fails if any `wsSend` payload mentions a secret, if `join-session` grows a field beyond `sessionId`/`pin`/`token`, or if a new secret-holding variable appears without being added to `roomSecretsInPlay()`.

### Three kinds of room

The lobby has a button for each. All hold the host and **one** guest. (A fourth kind, a saved person's room, has no button: it is made by a tap on their name — see "Saved people".)

| | PIN room | Open room | Code room |
| --- | --- | --- | --- |
| Created with | `create-session` | `create-session` `open:true` | `create-session` `code:true` |
| To get in from the list | type the 6-digit PIN | tap Join — nothing to type | type the shared **word** |
| Invite link | works, authenticates the key | the same | **none** — the word is the only way in |
| Verified (green) without comparing a code | only via the invite link | only via the invite link | **always**, once the word matches |
| Join locks | apply to PIN guesses | nothing to guess | host-side, on wrong-word attempts |
| Shown in the list as | 🔒 "PIN" | 🔓 "open" | 🔑 "word" |

An open room is first come, first served: whoever taps it first is in, it leaves the list, and anyone after that is told it is full. That is the whole meaning of "open" — **it is not a room for more than two people.**

### Code rooms — a short word, verified automatically (SPAKE2)

A PIN join is amber until the two people compare a code by hand, because the server makes the PIN and so cannot be shut out of the key agreement. A **code room** removes the hand step: the host invents a word, shares it out of band (says it, texts it), the guest types it, and the chat turns **green on its own**. The server never sees the word.

What makes a *short* word safe is that it can only be guessed **online, one try per connection**. There is nothing an attacker can capture and grind through offline. That property does not come from mixing the word into the key — doing that would hand an attacker exactly the offline dictionary attack to avoid — it comes from a real **PAKE**: **SPAKE2** (RFC 9382) over P-256.

- **`pake.js`** is the SPAKE2 protocol; **`vendor/noble.js`** is the audited elliptic-curve library it stands on (`@noble/curves`, bundled by `npm run build-vendor`, used unmodified). The curve math is never hand-rolled.
- **`test/pake.test.js` pins every step to the official RFC 9382 test vector** — `pA`, `pB`, the shared point `K`, the transcript, the derived keys, and both confirmation tags all match the RFC byte for byte. A second, independent check that the implementation is correct is not needed when it reproduces the specification's own numbers.
- The handshake runs over the data channel in place of ECDH: each side sends its SPAKE2 message, answers with a confirmation tag, and verifies the peer's. Matching words → the same key, authenticated → `e2eActivate(key, true)` → green. A wrong word → the tags do not verify → the channel never opens. Only public values cross the wire (a curve point, a tag); the word is **proven, never sent**, which is why `pake-msg`/`pake-confirm` are the only new types allowed outside the encrypted envelope.
- **The word reaches no server message.** `create-session` carries a boolean `code:true`, never the word; a test fails if any `wsSend` payload mentions `pakeCode`.
- **A code room offers no invite link.** The link carries the ECDH room secret, which this path does not use, so it would only fail to connect. The way in is the word.
- **A wrong word does not end the room.** The host turns the guest away (`release-guest`) and goes back to waiting, with a note — "Someone tried a wrong word — your room is open again" — and the guest goes back to the lobby, where the room is listed again. This used to be promised and not done: the guest's leaving deleted the room, so the right word could only ever find "not found", and the host sat on a dead chat screen believing it still had a room.
- **A code room outlives its guest.** Admission is first-come, so anyone can take the seat; a guest leaving used to delete the room, which let any stranger destroy any listed code room with one join. Now the server frees the seat and tells the host (`guest-left`); the host knows which it was. Before the word matched, it was an attempt, and the room stays. After, it was a chat, and the room goes as every room does once its chat has been — closed by the host, so the seat is never offered to someone else mid-chat. A code room's *host* leaving still closes it, and PIN and open rooms are unchanged.
- **Rate limit.** SPAKE2 already caps an attacker to one guess per connection; `codeAttemptState` in `guards.js` caps how many wrong attempts the host accepts at all — ten — before locking the room for five minutes, since the server cannot rate-limit a word it never sees. While locked, every guest is turned away, the right word too, and the host's note says the room is locked. When the five minutes are up the count starts again from nothing. **A guest turned away during the lock is told so**, and for how long: the host sends `release-guest` with `reason: "locked"` and the seconds left (`codeLockSecondsLeft`), the server passes on only that reason and only a wait of up to an hour, and the guest — only before any chat, so a host cannot use it to end one — says "locked, try again in N minutes" (`lockMinutes`, never "0") in the chat and again in the lobby, instead of "the other side left". The right word arriving during the lock used to have no way to know it should wait. It used not to: the count was kept, so the room locked again the moment its lock ended, for good — ten wrong words from anyone who could see the list, and the room's own guest could never get in.

Admission is the open-room model: the server lets the first person connect (it has no word to check), and the SPAKE2 handshake between the two browsers is the real gate. Only an explicit `code:true` makes a code room — anything else is still a PIN room.

A few rules keep a room from being open by accident:

- **Only exactly `open: true` makes a room open**, on the server and in the client. A string, a number, or a missing flag from an older server all mean a PIN room. The lobby compares with `=== true` for the same reason: reading the flag loosely would skip the PIN dialog for a room that wants one.
- **The server decides, not the list.** If the client taps a room it believed was open and it is not, the server answers `pin-required` — without counting it as a wrong guess — and the client opens the PIN dialog instead.
- **`joinVerdict` holds the rule** alongside the lock rules, with every combination tested: a PIN room never admits without its PIN or its token.

What an open room costs, said plainly: anyone who can see the list can connect to the host, which means they can message them, send them files, ring them, and — as with any peer-to-peer connection — learn their IP address. The host's panel says who can come in rather than leaving "no PIN" to be worked out. Someone arriving from the list has no invite-link secret, so the shield is amber exactly as it is for a PIN join.

`PUBLIC_SESSION_LIST=0` hides the list, and with it the only way to find an open room without its link.

### PIN joins have no secret

Someone joining by typing the 6-digit PIN — or by tapping an open room in the list — never received a link, so there is nothing to mix in. Those connections fall back to plain ECDH plus the manual verification code, and the shield in the chat header stays amber until the code is confirmed.

The host cannot know in advance which way a guest will arrive, so it derives **both** candidate keys and adopts whichever one opens the guest's confirmation packet. That is why an attacker forcing the weaker path is visible — the shield turns amber instead of green — rather than silent.

### Every message is sealed as whose it is, and where it goes

Found in a security assessment. Both sides sealed with the one key, and nothing said who sealed a message or in what order. Whoever could stand between the two — a signaling server that also swapped the transport's keys — could not read or change anything, but could hand a message back to the side that sent it, where it opened as if the other had written it ("yes, do it", bounced back as their reply), or deliver one again later as new. A file's chunks could be repeated or swapped round, and the file came out quietly wrong.

Now each seal carries **additional data** that AES-GCM checks but never sends (`DC.messageAad`, `DC.chunkAad`, `DC.confirmAad` in `protocol.js`):

- **Who sealed it** — `h` the host, `g` the guest. Each side opens only as the other's, so a message handed back does not open. The key confirmation is bound the same way.
- **A message's number.** Every sealed message — a text, or an `e2e-dc` envelope — carries the next number from its side, and opens only under it. A number already taken is turned away (`DC.takeSeal`): a copy delivered again is dropped, not shown, not acknowledged. Sealing is asynchronous, so two sealed at once may leave in either order; a number up to `SEAL_WINDOW` (1024) behind the highest is still taken, once. A text's number is bound together with its type and its id, so one cannot be passed off as another's tick or reactions.
- **A chunk's transfer and place.** The chat's channel keeps order, so the count so far is each chunk's place; a chunk opens only there, for its own transfer. One delivered twice, out of place, moved from another file or handed back fails the transfer rather than corrupting the file. The wire format is unchanged — nothing is added to a chunk.

Numbers start afresh with each key. Both sides must run this version — an older page's messages no longer open — which the build stamp already ensures ("One version in the browser at a time").

### The shield

The shield button in the chat header is the only standing sign of which of these a chat is in. `shieldState` in `guards.js` decides; `updateShield()` in `app.js` draws it.

| State | When | Colour | Glyph |
| --- | --- | --- | --- |
| idle | no key agreed yet | grey | plain shield |
| warn | encrypted, but nobody has checked for a middleman — a PIN join with the code not yet compared | amber | shield with `!` |
| ok | authenticated by the invite-link secret, or by typing the other side's code | green | shield with a tick |

Tapping it opens the code to compare. That panel is the only place the code appears: the chat itself says one word when a room connects — "Connected" — and it says it once the key is agreed, not when the channel opens, so a chat that fails the key check never claims it. The three lines that used to be written on every join (the transport, "setting up encryption…", the code) were removed on request as more than anyone read.

#### What the panel says

Under the code, the panel states what the chat is. It is the security panel, so every line has to be true, and three of them took some care:

- **Who can read it follows the shield.** "Only the two of you. The server cannot." is a claim that nobody is in the middle, so it is said only once that has been checked. An unverified chat gets a different sentence — encrypted, but a middleman cannot be ruled out until the code is compared. Both are drawn by `renderShieldFacts()`, which `updateShield()` calls, so the sentence and the colour cannot disagree.
- **The encryption is written out by hand** (`AES-256-GCM · ECDH P-256`, and `DTLS-SRTP` for calls), because the keys do not expose it in a form worth showing. `test/client-source.test.js` checks those words against the calls that do the work, so a change of cipher cannot leave the panel describing the old one.
- **Each device's IP address** comes from this browser's own connection statistics (`pathAddresses` in `connstats.js`) and from nothing the peer sent. "Your IP" on a direct connection is the public address a STUN server reported — the one the other side actually sees — not the device's address on its own network, which is what the route itself names. On a shared network it is the two local addresses. A relayed route shows none: those addresses belong to the relay. Browsers hide local addresses from pages (they arrive as random `….local` names), and a hidden address is shown as hidden, never guessed.

The panel also shows **each side's device** — system and browser, no version, no model. This is the one line that comes from the peer: each side sends two short codes (`peer-info`) inside the encrypted envelope, the guest first and the host in answer. What a peer sends is never written to the page. The codes are looked up in a fixed table (`deviceLabel`) and the words shown are ours, because a device "name" of the peer's choosing in the security panel — "✅ verified by server" — would be believed. It is still only what the other side *says* it is.

Showing addresses makes something visible that was already true: on a direct connection each side can see the other's IP. Before, that took developer tools; now it is one tap. In an open room that means anyone who joins sees the host's address.

This used to be a full-width warning banner across the chat. It was removed on request as more than the situation needed, and the shield took over its job, so a few things are now load-bearing:

- **Colour is never the only difference.** Each state swaps the glyph and the `aria-label` with it. Colour is no use to someone who cannot tell amber from green, and a tick drawn in amber would say "checked" about a chat nobody checked.
- **Nothing else may recolour it.** Hovering an icon button turns it white and opening the panel used to turn the shield green; both are overridden, because either would hide or misstate the state.
- **Every change to the verification state goes through `updateKeyVerifyUi()` or `updateShield()`.** With no banner behind it, a path that skips them leaves the old colour on screen.

Be honest about the trade: an icon is easier to miss than a banner, and with the join messages gone as well it is the **only** thing that distinguishes an unverified chat. Someone who never looks at the shield will not notice a PIN join that should have been a link join.

The PIN and token cannot substitute for the room secret: the server generates both, so it already knows them.

### Lifetime

Links are short-lived by nature. A room exists only in the server's memory and disappears when **either** participant disconnects, after ten minutes with nobody having joined (the host is told — see "Rooms" below), when its host opens or joins another room, or whenever the server restarts. An "old" link points at a room that no longer exists and simply reports *session not found* — so there is no population of stale links to worry about.

## Why the decisions live outside app.js

`app.js` needs a browser and two peers, so nothing in it could be executed by the test suite. Round after round of analysis found real bugs in it, and **almost every one was a decision or a small state machine** — not DOM code:

| Bug | The decision behind it |
| --- | --- |
| A peer could open the camera with no prompt | may capture start? |
| A voice call was upgraded to video by the peer | how much video was agreed to? |
| Plaintext messages were displayed | may this be shown? |
| Unencrypted file announcements and call requests were acted on | may this be believed? |
| A voice note reached the next room's peer | which room does this recording belong to? |
| A double-click left the microphone on | may the microphone open? |
| An invite-link join hung forever | should this join be retried? |
| One room expiring closed the chat in another | which room is this message about? |
| The wrong network route was reported | which candidate pair is actually in use? |

So the decisions moved to `guards.js` and `connstats.js`, and the effects stayed put. Both modules are pure — no DOM, no module state, no side effects — so every combination can be asserted directly, including the ones nobody thinks to try. That is where the bugs were.

The split gives the two test files different jobs:

- `test/guards.test.js` and `test/connstats.test.js` prove the **answers are right**.
- `test/client-source.test.js` proves `app.js` **asks**, and asks before acting. A correct guard nothing calls is worth nothing, and no test of `guards.js` could ever notice.

**Deliberately not done:** the rest of `app.js` is still one file of stateful WebRTC and DOM code. Splitting it further would mean restructuring live code that has no runtime coverage — recreating the exact risk this was meant to reduce. Extracting a decision is safe because it is provably pure; moving effects around is not. If more comes out later, it should be more decisions.

## The author, at the top left

Asked for: the author's photo and name in the app. A small round photo sits at the lobby's top left — the language switch is at the top right — and a tap opens a short panel: the photo larger, the name, a sentence on why the app was made (both languages, `authorAbout`), and LinkedIn, Facebook and YouTube as icons. No degree, workplace, email or phone number: the app is the way to reach them. Each link opens in a new tab and gives nothing of this page away (`noopener noreferrer`); its name is hidden text for a screen reader, since a brand name reads the same in both languages and the page keeps no English-only label.

It opens and closes like the about panel beside the title — a tap elsewhere closes it, and opening one closes the other — and Escape now closes either. It is part of the lobby, so it is not there in a chat.

The photo is `icons/author.jpg`: cropped to head and shoulders and drawn afresh at 192×192 (about 7 KB, from a 538 KB original, with none of the original's camera data), served by the server, and part of the build — `sync-build` stamps it and hashes it as bytes, as it does the PNG icons.

## The lobby: three tabs

Under the title the lobby has three tabs — **Rooms | Create room | Notes** — and shows one section at a time. It opens on Rooms, because most people arriving are joining someone, and returns there after a chat. The Rooms tab carries a count of open rooms, so it can be seen from the other two. A created room brings its host to the Create tab, where the PIN and link are; a room that expires while its host is on another tab is also said as a toast. Arrow keys, Home and End move along the tabs (`showLobbyTab`, `lobbyTabKeyTarget` in `app.js`).

**`#lobbyStatus` is for news that belongs to no tab.** The create card's status line used to carry everything: the server waking up, "Joining…" from an invite link, a link that was refused. With Rooms open by default, all of that would have been said inside a hidden tab. It now goes on a status line above the panels, shown on every tab and taking no room when empty. `#createInfo` keeps only what is about creating: "Creating…", the PIN and link, the room expiring.

## A locked screen does not end the chat

**The bug:** put the phone down for a minute and the chat was gone. A phone whose screen locks pauses the page, and an iPhone cuts the page's link to the server almost at once. The server saw that link drop and sent the other side `peer-disconnected`, and the other side's app ended the chat — though the chat runs directly between the two phones, and that link was still up, or would have been when the screen came back on.

**The server's word alone no longer ends a working chat** (`serverLeaveEndsChat` in `guards.js`). If the data channel is open and ICE is `checking`, `connected`, `completed` or `disconnected`, the notice is noted (`serverRoomGone`) and the chat goes on; the direct link decides from then on:

| What happens next | What the chat does |
| --- | --- |
| the other side wakes up | carries on; whatever was sent meanwhile arrives |
| the other side taps Leave | its channel closes, and that is said as "Peer disconnected" |
| the direct link fails | over: with the room gone from the server, nothing can carry an ICE restart (`linkLostForGood`), so it says "Lost the connection to the other side" instead of "retrying" for ever |

Our own link to the server dropping no longer marks the room gone: the server keeps our seat and we take it back on reconnecting — see "A chat survives a dropped link to the server". Only a page without a key to do that (from an older server) takes the room as gone, as it used to. One Back button, however many ways a chat ends at once.

**While a room is open the screen does not lock by itself** (`keepScreenOn`, the Screen Wake Lock API): from creating a room or joining one until the chat ends or you leave. The browser lets go whenever the page is hidden, so it is taken again when the page comes back, and again on a tap if Safari refused it without one. Where the API is missing or says no (battery saver), the screen behaves as usual. The power button still locks the phone.

**During a call**, a lock had two more effects, now handled (`tracksToRestart`, `callPauseNote` in `guards.js`; the block "A call across a locked screen" in `app.js`):

- **The microphone and camera come back by themselves.** A phone may stop them for good while locked, and nothing started them again: back on the screen the call was up but the other side heard and saw nothing. On return, whatever ended is opened again and swapped into the call with `replaceTrack` — no new call, no renegotiation. Only what ended, only in an agreed call (`mayCaptureForCall`, asked before opening and again after), never a camera for a voice call; muted stays muted and a camera turned off stays off. A track the phone takes while the page is showing is restarted at once; a device that keeps failing is given up on after five tries, with a toast.
- **The other side is told.** Each side sends `call-away` when its page is hidden and `call-back` when it returns, sealed like all call signalling, and the call screen says "The other person's screen is off, or they switched apps". If that message never gets out before the phone sleeps, the call's own link going down says "Reconnecting…" instead.

**A phone locked long enough that the direct link fails** is now covered too, for up to ten minutes: the server keeps its seat, the waking phone takes it back, and the link is repaired through it — see "A chat survives a dropped link to the server".

## The host's own room

- **A waiting room survives its host stepping away** — see "A room that waits for its host". Only if it cannot be taken back (kept too long, or the server restarted) does the Create tab say "Your room closed — the connection to the server dropped", with **Create again**: same name, same kind, and for a code room the same word, which the guest already has. A PIN room then gets a new PIN.
- **A Create pressed while the link is down goes when it is back.** `wsSend` drops messages while the link is down, so this used to leave "Creating…" on screen and every create button disabled for good. The create message is kept as `pendingCreate` until the server answers, and sent — again, if need be — each time the link comes up; a room the server made and then dropped with the old socket is just made afresh. It carries the `code` flag, never the word, and `test/client-source.test.js` follows it there.
- **Your own room in the list says "Your room"** (`isOwnRoom`) instead of offering a Join button that could only fail.
- **A create sent again gets its own room, not "name taken".** A create waiting for its answer is sent again when the link comes back (`pendingCreate`). If the first had arrived and only its answer was lost, the server had made the room and kept it for its away host — and refused the second as "name taken", the page's own room blocking its name, with no host key to take it back. Each create now carries a key of its own (`makeCreateKey`, the same every time that create is sent); the server keeps it with the room, and answers the same key with the same room — same PIN, same token, same host key, a guest who arrived meanwhile introduced — without counting it as another room (`adoptRoom`). Another key, a malformed one or none is still "name taken", and a room whose chat has begun is never given up to it.
- A refused invite link says why once: the second line, "the room may have expired", followed every refusal, and was wrong after "full".

## A room that waits for its host

To send the link, the host copies it and switches to a messaging app. The phone pauses the page, and an iPhone cuts its link to the server almost at once. The server used to delete the room with the link, so the link the friend received was dead by the time they tapped it.

- **The server keeps a waiting room for `HOST_AWAY_MS`** (ten minutes) when its host's link *drops* — a socket closing, not a leave. It stays listed. Leaving on purpose, or creating another room, still closes it at once. A room whose chat has started is kept too, for either side — see the next section.
- **The host takes it back with its host key** (`reclaim-session`): a secret the server gives only the host's page with `session-created`, never in a link and never in a list, compared in constant time. A guest who has the link cannot take the room. Taken back, it is the same room — the same PIN, the same token, so the same link — and its ten minutes to find a guest start again.
- **A guest who arrives meanwhile gets in and waits.** `session-joined` says `hostAway`, and the chat says the host has stepped away instead of counting down to "could not connect"; when the host is back, the guest hears `host-back`, the host hears `guest-joined`, and they connect as usual. A guest who gives up and leaves frees the seat. A host who never comes back: the room goes once its time is up, and a guest still waiting is told.
- **The page itself may be closed in the background.** So the host's page keeps its waiting room in `sessionStorage` — this tab only — and a page opened fresh takes it back from there at its first connection (`restorableHostRoom` checks the record before it is believed). The record holds the room's secret and, for a code room, its word, so it lives no longer than the room: forgotten when the chat starts, the room ends, or the host leaves. The reclaim message carries the room's name and the host key, and nothing else.

## A chat survives a dropped link to the server

**Found assessing why calls did not survive a phone changing networks** — Wi-Fi to mobile data, say. Three things stood in the way:

1. **The server deleted the room the moment either side's link to it dropped** — and a phone changing networks drops that link. With the room gone, nothing could carry a repair, so a chat whose direct link then failed was over.
2. **The repair waited for the link to be declared failed** — tens of seconds — and only the host could start it. On a link that was only `disconnected` the page called `restartIce()`, which nothing then acted on.
3. A call's own recovery rides on the chat's channel, so it went down with the chat.

**The server now keeps a chat's seat** for `HOST_AWAY_MS` (ten minutes) when either side's link *drops* — a socket closing, not a leave:

- **The guest gets a guest key** with `session-joined` — like the host key, never in a link or a list, compared in constant time, and made afresh for each guest. On reconnecting, the guest takes its seat back with it (`rejoin-session` → `session-rejoined`); the host does with its host key (`reclaim-session` → `session-reclaimed` with `resumed: true`). The other side hears `peer-away` when the link drops and `peer-back` when the seat is taken back; neither ends anything, since the chat may well go on directly in between.
- **While a seat is kept, nobody else takes it**: the room says full and is not listed.
- **A side that does not come back**: once its time is up, the other side hears `peer-disconnected`, as before, and a seat it then tries to take back is refused (`rejoin-failed` / `reclaim-failed`). So is one after the server restarted. The page then takes the room as gone (`roomGoneForGood`): the chat goes on while its direct link is up, and ends if that has failed.
- **Leaving on purpose still ends the room at once.**

**And the chat's link is repaired from either side, a couple of seconds down** (`G.chatRepair`, run once a second by `stepChatRepair()` while the link is `disconnected` or `failed`):

- **The host makes a fresh offer** — an ICE restart through the server (`renegotiate-offer`); **the guest asks it to** (`repair-request`, which the server passes on). The host alone offers, so two offers never cross. After two seconds down, then every six.
- **Only while the way through the server is open** — our seat and theirs — since otherwise it would go nowhere. The moment it opens (`session-rejoined`, `session-reclaimed`, `peer-back`), the repair goes at once rather than at the next step. The guest may see the link down before the host does, so the host acts on an ask even if its own side still looks up — at most once every three seconds.
- **There is no giving up here**: the seat's own wait ends the chat if a side never comes back, and so does the chat's channel closing. Once that channel has closed — the other side gone for good — nothing is repaired: no fresh route reopens it.
- **A candidate for the fresh route that arrives before its description** is kept and tried again with it, and an answer to an offer nobody made is ignored.

Checked with two tabs on a local server: each side's link to the server cut mid-chat (the seat taken back on the new link, the chat never interrupted, the other side seeing `peer-away` then `peer-back`); a guest's ask (both sides took new ICE credentials and stayed connected); the repair itself, on each side, with the link made to read `disconnected` and `failed` (an ask, or an offer, at two seconds, then stopping once back up); and the server restarted mid-chat (both pages told the room was gone, the chat going on, a message still arriving).

**Still not covered:** a network that blocks a direct link outright — that needs a relay (TURN); see the end of "A call whose link drops tries again". And the server keeps rooms in memory: a restart (every update is one) loses every seat at once. A chat whose direct link is up carries on regardless.

## Opened inside another app's browser

A link sent through Facebook, Instagram, Messenger and the like opens in that app's own browser, not Safari or Chrome. It is run by the app, which can add its own code to the pages it shows (researchers showed in 2022 that Facebook's and Instagram's do); it often may not use the camera or microphone, so calls fail; and it closes, chat and all, when the app is left. `inAppBrowser` in `guards.js` recognises the common ones by name and any other Android WebView or iPhone browser that does not call itself Safari — never our own home-screen app, whose user agent does not either.

The page then says so first, before anything else, and offers the ways out (`inAppAdvice`):

| | |
| --- | --- |
| iPhone | **Open in Safari** — `x-safari-https://…`, which hands Safari the whole address, invite and all. Not an official feature: some apps block it, and then the note says to use their ⋯ menu. |
| Android | **Open in browser**, for the default browser — an `intent://` address — only when there is no invite in the address: it cannot carry the `#fragment`, which is where an invite keeps its secret, and the secret must never be moved anywhere a server would see it. |
| both | the app's own ⋯ → Open in browser, which takes the address as it is; **Copy link**, the whole invite, to paste into Safari or Chrome; **Continue here**. |

**While the notice is up, the invite stays in the address and nothing joins.** The page normally takes the invite out of the address as it loads; inside an app it keeps it, or Open in browser would carry a bare address. And it does not join: the seat is the friend's, and it belongs to the browser they are about to open — taken by the app's browser, it would leave the real one "full". Continue here lets go: the address is tidied and the invite joins, and this tab is not asked again. The Install button is hidden there too: nothing can be installed from inside another app.

Nothing here makes the app's browser safe; it only makes leaving it easy. A link sent through any app is also readable by that app and anyone in that chat — see "Code rooms" for a word that is said, not sent.

## The phone's Back button

To a phone, Back means "leave this page", so pressing it mid-chat closed the page and ended the chat for both people. While a chat is on screen, the page now holds one history entry of its own (`armBackGuard`): Back lands on this page instead of leaving it, and asks **"Leave the chat?"** — the chat ends for both of you; to keep it going while using another app, use Home or the app switcher. Back again, or **Stay**, keeps the chat; **Leave** leaves it. Once a chat has ended, Back just goes to the lobby (`backPress` in `guards.js`).

- **Chrome skips an entry a page added before the user touched it**, so Back would sail past it. A page opened from an invite link connects untouched, so there the entry is added at the first tap instead.
- **During a call that fills the screen, Back makes the call small**, with the chat underneath — as the call's own chat button does (`backPress` says `mini`). Reported: Back in a call asked "Leave the chat?" over it, one tap from ending the call and the chat together. With the call already small, Back asks as in any chat.
- **The X at the top of the chat asks too.** Reported: it was an arrow, which read as "back" rather than "end the chat for both of us", and it left at once. Now it is an X and, pressed by hand in a chat that is on, asks the same question (`leaveAsks` in `guards.js`). The app's own clicks on it — the question's **Leave**, an ended chat's way back — are not trusted events, and leave at once as before. In an ended chat, or a copy whose link was opened in another browser, it goes straight to the lobby, and so does Back (`chatEndedHere`).
- **The entry is given back when the chat is left** — by Leave, the X, or a code room's host going back to waiting — so Back in the lobby goes where it always did. Only ever our own entry: going back past another would leave the page. And only once the chat is off screen, since giving it back queues a Back of its own.
- **Closing the tab or window mid-chat asks first** (`beforeunload`). It is listened for only while a chat is on: merely listening can keep a browser from caching the page.

This keeps Back from ending a chat; it does not make a chat run in the background. Home or the app switcher does that, within the limits each phone sets — see "A locked screen does not end the chat".

## A connection that never comes up

Some networks block direct connections, and with no relay server two such devices cannot reach each other at all. Both sides used to sit on "Connecting…" for as long as anyone watched. Thirty seconds after the chat screen opens (`CONNECT_GIVE_UP_MS`), if the channel has still not opened (`connectStalled`), the chat says so — one of the networks may be blocking direct connections; try switching between Wi-Fi and mobile data — with the Back button. It keeps trying underneath: a slow network that gets there late still connects, and the screen is kept on again when it does. A channel that opened but failed its key check is not this case; it says so itself.

## The name

The app is **Өртөө** in Mongolian and **RelayLink** in English — one key, `appName` in `i18n.js`. The lobby heading, the about panel and the tab's title follow the language chosen, and the tab is renamed the moment the language is switched (`applyI18n` calls `drawTitle`). What cannot change with the language puts the Mongolian name first: the installed app (`short_name` "Өртөө", full name "Өртөө — RelayLink"), the page's `<title>` before the script runs, and the link-preview card. The email a left message arrives as says RelayLink.

The repository is `AnirKh/RelayLink`, so the app is at `https://anirkh.github.io/RelayLink/` — capital R and L: GitHub Pages tells the two apart, and `/relaylink/` is not found. The old `/direct-connection/` address stopped working with the rename; saved people and rooms survive it, since the browser keeps them per site (`anirkh.github.io`), not per address — except in an iPhone Home Screen app installed before the rename, which keeps its own storage behind its dead icon. The Pi fetches from `AnirKh/RelayLink` directly; GitHub's forwarding of the old repository address is not relied on.

What keeps `direct-connection`: the Pi's services, folders and settings file (`deploy/pi/`), and the labels the keys for saved people and the mailbox are made from. Those labels are part of the keys — renaming them would orphan every saved person.

## Installable as an app

The site can be installed: an icon on the home screen or desktop that opens in its own window, with no browser bar. `manifest.webmanifest` names it and lists the icons; `index.html` links it, plus the `apple-touch-icon` and `apple-*` lines iPhones read instead.

An **Install app** button sits at the bottom left of the lobby, and only where it can do something (`installOffer` in `guards.js`):

| Where | What the button does |
| --- | --- |
| Chrome, Edge, Samsung Internet | The browser offers to install (`beforeinstallprompt`); the offer is held, and the button spends it — the browser's own install window opens. An offer is good once, so the button goes with it. |
| iPhone, iPad | No page can install itself there. The button opens three steps: Share, Add to Home Screen, Add. iOS has no Mongolian, so those names stay in English. An iPad describes itself as a Mac; a Mac with a touch screen is taken for one. |
| Already running as the installed app | No button. |
| Firefox, Safari on a Mac | Cannot install a site from a button: no button. |

**No service worker.** Chrome and Edge no longer need one to offer the install — checked with the browser's own installability report, which lists nothing missing. A worker that cached files would also fight "One version in the browser at a time": it is exactly a second copy of the client that can go stale.

**Icons.** `icon.svg` is drawn on a 512 grid with everything inside the central circle a launcher may crop to. `icon-192.png` and `icon-512.png` are it with see-through corners; `icon-maskable-512.png` and `apple-touch-icon.png` are the same drawing on a full square, since Android crops a maskable icon to its own shape and iOS rounds the home-screen icon itself. The manifest, the SVG and the apple icon are in the build stamp, and pictures are hashed as bytes rather than text. The other PNGs are named only in the manifest and so are not stamped: if one is redrawn, give it a new name.

## Link previews

A shared link used to arrive bare in Messenger, Telegram, Facebook or WhatsApp. `index.html` now carries `og:*` lines (read by all of those), `twitter:*` lines and a `description` for search engines, so a link shows the name, one line of what it is, and `icons/link-preview-relaylink.png`.

- **Every address is absolute** and points at GitHub Pages, the address people share — preview fetchers do not resolve relative ones. The server's own copy of the page (the Pi's) says the same, and `<link rel="canonical">` tells search engines which of the two is the main one. `test/csp.test.js` lets exactly that tag through without an integrity hash, since it loads nothing.
- **An invite link previews as the same card.** Its secret is in the `#fragment`, which no fetcher ever sends, and nothing in the card is built from the live address.
- **The picture** is 1200×630, the shape the big cards are drawn in, with the icon and name in the middle so a square crop keeps them, and under 300 KB, past which WhatsApp drops it. It is rendered from an HTML page; the services cache it by address, so a redrawn picture needs a new file name to show up.

## Calls: consent is local, never taken from the wire

Two rules. `test/guards.test.js` proves they give the right answer; `test/client-source.test.js` proves `app.js` asks before capturing:

- **`getUserMedia` runs only when `inCall` is already true.** `inCall` is set by pressing a call button or Accept — nothing a peer sends can set it. Every function that reaches `attachCallMedia()` must check it first, or the peer can skip the prompt and open the camera by sending `call-offer` or `call-accept` cold.
- **`pendingCallVideo` decides whether the camera is used, not the peer's `withVideo` flag.** That flag rides in on every call message; `consentedVideo()` ANDs the two, so the peer may answer a video call with audio only but can never add video to a call you asked to keep voice-only.

The test walks whichever functions call `attachCallMedia` rather than a fixed list of names, because the guard was added to one of the two paths first and the second went unnoticed for a release.

## The self-view: mirrored here, movable

In a video call your own picture is shown **mirrored**, the way a mirror shows you, and the other person sees you the right way round. The mirror is one CSS transform on `#localVideo` and nothing else. It flips the element on this screen; the track that is sent is the camera's own. Flip the track instead — in script, or by redrawing the camera through a canvas — and the other side receives a mirror image. `#remoteVideo` is never flipped: text behind the other person would read backwards.

The self-view can be **dragged** anywhere inside the call, by mouse or finger. Until it is moved, CSS keeps it in its corner; once moved, `moveSelfView()` places it by `left`/`top`, and `selfViewPosition()` keeps all of it at least 8px inside every edge. A `ResizeObserver` puts it back inside whenever the call or the picture changes size — a phone turned on its side, a camera whose shape is only known once it starts — so it can never be left off screen with no way to reach it. A hidden call measures 0×0; that is ignored rather than believed, or the picture would jump to the corner it was moved out of. Where it was put is kept for the next call on the same page, not across reloads.

The call buttons stay on top of it, so dragging it under them never blocks End call.


**Your own picture big.** Asked for: a tap on your own small picture to see it big. A tap — a press that never travels past a few pixels, not a cancelled one — swaps the pictures' places: yours fills the call, still mirrored, and theirs goes small where yours was, in its own shape; a tap on theirs swaps back (`setCallSwapped` in `app.js`, `.call-overlay.swapped` in `style.css`). A drag still moves it. The places are swapped, not the streams: theirs carries their sound, and moved into the muted self-view it would go silent. Big, yours is neither dragged nor swapped by a tap; the place it was dragged to is kept for when it is small again. Not in a voice call, nor the small call, and a call made small or ended comes back the usual way round. Checked in a two-tab video call: tapped, yours filled the call with theirs small and their sound still playing; tapped again, back.

## Flipping the camera

A video call on a phone or tablet has a button to switch between the front and back cameras. It shows only where there is another side to flip to — more than one camera, and the one in use says which way it faces (`G.flipCameraOffered`). A computer's webcam says nothing about facing, so a computer never gets the button.

`flipCamera()` puts the other camera's track into the **same sender** with `replaceTrack`: no new call, nothing renegotiated, the other side just sees a different picture. What it has to get right:

- **The camera in use is stopped before the other is opened.** Many phones run one camera at a time and refuse the second while the first is open. iOS stops the first itself — which `watchCallTrack` would take for the camera dying, and start a restart in the middle of the flip. `stop()` fires no `ended`, so stopping it ourselves sets nothing off.
- **It asks before opening and checks again after**, like every other door to the camera: `G.mayFlipCamera` — a call that is on, that already has a camera, with nothing else changing it — and `mayCaptureForCall` once it has opened. A flip never brings video into a voice call. It shares `restartingCallMedia` with the restart after a lock, so the two can never swap tracks at once.
- **A camera that will not open leaves the call as it was.** The one that was in use is opened again and a message says the switch failed. If neither will open, the call goes on with sound, and coming back to the page tries the camera again.
- **Only the front camera is mirrored.** The back camera shows the world; text in it should read the right way round on this screen too. `showCameraFacing()` sets a class and the stylesheet does the rest — the mirror stays the stylesheet's alone.
- **A restart after a lock opens the camera last flipped to.** Both it and `attachCallMedia` ask `callVideo()`; a fixed "front camera" there turned a back camera round on every unlock. Each new call starts on the front camera.

## A call whose link drops tries again

Asked how to make connections steadier. A call has its own connection, beside the chat's. When the chat's link failed it already tried again (an ICE restart, through the server); when a **call's** failed — Wi-Fi to mobile data mid-call, a moment without signal — the call simply **ended**.

Now it tries first (`G.callRecovery`, run once a second by `stepCallRecovery()` while the link is down):

- **The side that placed the call asks for a fresh route** — an ICE restart (`createOffer({ iceRestart: true })`), sent as `call-restart` over the chat's encrypted channel and answered with `call-restart-answer` on the **same** connection, so the camera and microphone carry on and nothing is set up again. Only that side asks, so two offers never cross. It asks after three seconds down — a blip may mend itself — and again every eight seconds. With the chat's channel down too, the ask waits for it.
- **The call says "Reconnecting…"** meanwhile: a failed link now counts as reconnecting, not just a disconnected one (`G.callPauseNote`).
- **After half a minute down, both sides give up**: the call ends with `endCall(true)`, so the other side is told, and the chat says the connection was lost rather than leaving a frozen picture.
- **A candidate that arrives before the fresh description it belongs to** — the two travel separately — is kept and tried again once the description is in, rather than lost.
- **Closed is still the end**: a connection that is closed was put down on purpose.
- **The other side leaving ends the call at once.** Reported: when one side left mid-call — the X, then Leave — the other's call froze on "Reconnecting…" for half a minute, then said the connection had dropped. Leaving ended the call only on the side that left, and the other waited for this recovery to give up. Now the chat's channel closing ends the call there too, as a hang-up would: "Call ended", then that they left — or a missed call, if theirs was still ringing (`G.callWhenChatCloses`, in the channel's close handler).

A failed fresh route does not end the call by itself — that is the recovery's job when it gives up — which is why `handleCallRestart` and `handleCallRestartAnswer` are held to a rule of their own in `client-source.test.js` rather than to the call-setup one. Checked in a two-browser call by asking for a fresh route mid-call: both sides took new ICE credentials, the call stayed connected, and video kept arriving both ways.

**Not done yet: a relay (TURN).** The app has STUN servers only, which help two devices find each other but carry nothing. Where a network blocks a direct link — common on mobile data, and on some office, hotel or school Wi-Fi — the devices cannot connect at all; recovery cannot help a route that never existed. A TURN relay fixes that, passing along traffic it cannot read (messages are end-to-end encrypted, calls DTLS-SRTP). The plan is Cloudflare's TURN service, with the server handing each page short-lived credentials so its secret never reaches a page.

## The call's controls step aside

Reported: during a call the "connected" label and the buttons stayed on screen for good, and a shared screen was hard to see behind them. Now, once a video call is connected and nothing has touched it for four seconds, the status, the figures and the buttons fade out (`showCallChrome()` / `hideCallChrome()`), and on a computer the pointer goes too. Any tap, click, key or movement over the call brings them back, and the four seconds start again.

- **`G.callChromeMayHide` decides**: a video call, connected, with no pointer resting on the buttons and no keyboard moving through them. Before the call connects the label says what is happening, and in a voice call there is nothing behind the buttons to see, so neither fades. A check that says "not yet" looks again four seconds later rather than giving up.
- **The tap that brings them back presses nothing.** Faded, the buttons take no taps (`pointer-events: none`), and for a moment after they reappear they still take none (`chrome-waking`), so a tap on the empty screen cannot land on a button that was invisible when the finger came down — checked by clicking exactly where the hidden End call button was: the call went on, and the controls came back.
- **A button's leftover `:hover` on a phone does not count** as a pointer resting on it; only a device with a real pointer (`(hover: hover)`) does.
- **The self-view and the "away" note are not part of it** — they stay.

## Upright pictures only

The laptop that heard an iPhone but never saw it, found: the figures below showed the phone's video **arriving and decoding** on the laptop, and with the phone **turned sideways it appeared**. An iPhone held upright sends its picture sideways, with an instruction to turn it — the `urn:3gpp:video-orientation` RTP header extension — and Edge on that laptop drew such pictures black. The laptop's own camera never needs turning, which is why the phone always saw the laptop. (The two fixes made before this was known — ignoring device changes while a call starts, and H.264 first — were not the cause, though both stand on their own.)

So that extension is taken out of every call description this side writes (`setCallLocalDescription()`). A call negotiates it only if both the offer and the answer carry it, so either side leaving it out is enough — an older version of the app on the other end included. Without it the **sender** turns the picture upright before sending, and every receiver gets a picture it only has to show. A browser that refuses the changed description is given the original, and the call goes ahead as it always did.

The cost is on the sender: a phone turns each frame itself, and a phone rotated mid-call sends a picture that changes shape rather than an instruction. Checked with two browsers through a local server: neither the offer nor the answer carries the extension, the browser took the change without falling back, and video flows both ways. That Edge now shows an upright iPhone is checked with the two devices.

## What the call's video is doing

A video call shows two small lines under its status: what arrives (↓) and what goes out (↑) — format, size, frames a second, rate — read every two seconds from the call's own stats (`DCS.callVideoStats`, drawn by `updateCallStats()`). A voice call shows none.

Added while chasing a laptop that heard an iPhone but never saw it, after two fixes made from reasoning alone did not change it. "Not sent", "not arriving" and "arriving but not decoded" all look like the same black picture; these figures tell them apart:

| The laptop's ↓ | The phone's ↑ | Means |
| --- | --- | --- |
| "no video arriving" | nothing, or 0 kb/s | the phone is not sending |
| "no video arriving" | sending, with a rate | sent, lost on the way |
| a rate, but 0 fps and no size | sending | arrives, never decoded |
| fps and a size | sending | decoded — the fault is in showing it |

## The call's video format: H.264 first

Reported: a laptop (Edge) calling an iPhone heard it but never saw it, while the iPhone saw the laptop. A call's video format is chosen from the list of whoever places it. Chrome and Edge list **VP8** first, so when the laptop called, the iPhone had to *send* VP8 — which it can only do in software — and its picture never arrived. An iPhone placing a call lists **H.264** first, which every iPhone encodes in hardware, and phone-to-phone calls always worked.

So both sides now put H.264 at the top of their list (`preferCallVideoCodecs()`, via `setCodecPreferences`), once the camera is in its transceiver and before the offer or the answer is written. Where both have H.264, every call uses it, whichever side places it. Everything else keeps its place below it as the fallback, so a browser without H.264 negotiates exactly as before, and one that refuses a preference keeps its own order. Checked with two browsers through a local server: placed from the Chrome engine, the call now negotiates H.264 in both directions, where it used to pick VP8. The iPhone-to-Edge picture itself is checked with the two devices.

## Sharing the screen

In a video call, a share button puts the screen in the camera's place. **Only where the browser can share** — a computer's (Chrome, Edge, Firefox, Safari on a Mac). No iPhone or iPad browser can share its screen, and mobile browsers generally cannot, so there the button never shows (`SHARE_SUPPORTED`, `G.shareOffered`). Watching a shared screen works everywhere: to the other side it is the video it was already getting.

- **The browser's own picker is the consent.** It asks which screen, window or tab, every time; nothing is shared without it. `G.mayShareScreen` decides only whether the call is one to share into — an agreed video call, nothing else changing its devices. Closing the picker leaves the call exactly as it was, with no message: not sharing is not an error.
- **The same sender** (`replaceTrack`): no new call, nothing renegotiated. A voice call has no video sender, so it gets no button.
- **The camera is stopped while sharing** — nothing captured that is not being sent — and opened again when sharing stops, by the button or the browser's own "Stop sharing" (the screen's track ending). The camera comes back as it was: facing the way it was last flipped, and off if it was turned off before sharing. If it will not open, the screen stops anyway and is left ended in the call, so coming back to the page tries the camera again.
- **The self-view shows what is shared, unmirrored** (`#localVideo.screen-share`) — what the other side sees, as they see it. The button is lit while sharing.
- **Nothing puts the camera back over the screen.** The flip refuses while sharing (`G.mayFlipCamera`), `restartLikeCallStart()` does nothing, and headphones moving move only the microphone.
- **A sharer in another window is not "away".** The sharer is usually in the window being shown, so the page being hidden does not send `call-away` while sharing.

- **Held to Full HD.** Reported: shared from a laptop, the whole screen went out at full size — 2560×1600 and more — costly and laggy, worst on the phone receiving it. So it is held to at most 1920×1080 with its shape kept, and to the size, frame rate and data rate of its profile (below; `SCREEN_MAX`, `SCREEN_PROFILES`). It is asked three ways, since browsers differ in which they honour: of the picker (`getDisplayMedia` constraints), of the captured track (`applyConstraints`), and of the sender (`setParameters`: `maxBitrate`, `maxFramerate`, and `scaleResolutionDownBy` worked out from the captured size by `screenScale()` — never above 1, so a small screen is never scaled up). The sender's limits are lifted when sharing stops, camera or not, so the camera goes out at its own size again. Checked with two browsers: a 2560×1600 screen at 30 fps went out as 1728×1080 at 15 fps, capped at 2.5 Mb/s, and the limits were gone once sharing stopped.

- **The screen's own sound, mixed in.** Reported: a video playing on the laptop sounded bad on the phone. Only the picture was shared, so the video's sound reached the call off the laptop's speakers through its microphone, and the call's echo and noise filters — made for speech — chopped it up. The picker now offers the sound too (`audio: true`, `systemAudio: "include"`): a tab's, or on Windows the whole screen's. Ticked, it is mixed with the microphone through Web Audio (`mixScreenSound()`) into one track that takes the voice's place in its own sender — the call has one sound to send, and nothing is renegotiated. The microphone stays a track of its own underneath, so **muting mutes the voice and leaves the shared sound playing**; headphones connected meanwhile go into the mix in the old microphone's place. Stopping puts the voice back alone and stops the shared sound. If the sound cannot be mixed, the picture is still shared. With the laptop's speakers on, its microphone still hears them, so a tip says once that headphones keep it clean.
- **Smooth for a video, sharp for a page.** Ticking the sound is also the best sign of what is being shared: with it, a share is nearly always a video and goes at **720p (1280×720) and 60 frames a second**, 4 Mb/s, sent for motion (`contentHint: "motion"`); without it, a page — **Full HD and 30 frames a second**, 2.5 Mb/s, sent for detail (`SCREEN_PROFILES`). Asked for: videos at 60 one step down in size, and documents at 30 rather than 15, smoother to scroll. A video's 4 Mb/s is what Full HD at 30 had, about as much per pixel; a page that sits still costs little at any rate. The picker is asked for the most either takes (Full HD, 60 frames a second), and the track (`screenConstraints()`) and the sender (`screenScale()` against the profile's size) are then held to the one it is. Checked in a two-tab call with a 2560×1600 moving picture standing in for the screen: with sound it went out at 1152×720 and 58 frames a second, nothing limiting it, and arrived at 1152×720, about 52 a second, 3.4 Mb/s, in a tab in the background; without, at 1728×1080 and 30.

Checked with two browsers through a local server and stand-in tones — 300 Hz for the voice, 1000 Hz for the screen — measured on the receiving side: before sharing only the voice arrived; sharing with sound, both; muted while sharing, only the screen's; after stopping, only the voice, in its own sender again. Checked with two browsers through a local server, a stand-in screen and cameras: the other side saw camera, then screen, then camera again, in the same senders.

## The other person's voice, loud and steady

Reported: on an Android phone, an iPhone's voice was loud and clear in one call and far and quiet in the next — or within one. How loud a voice leaves a phone changes with how far it is held from the mouth, and with the phone's own clean-up (echo, noise, loudness), which turns a voice down while it works. Nothing on the listening side evened that out.

**Now it is evened out as it arrives** (`levelVoice`, `G.VOICE_LEVELLER`): a compressor brings quiet and loud parts closer and lifts them both by its own make-up gain, and a limiter keeps the loudest from distorting. Measured in Edge's own Web Audio with a voice-like sound: arriving anywhere from -40 to -6 dB (34 dB apart), it comes out between -24 and -13 (11 dB apart); ordinary speech 6 dB louder, a far voice 13 dB louder. In a real call between two Edge tabs, a voice arriving at -40 dB was heard at -27. The picture still plays in the `<video>`, muted, so the voice is heard once; a silent `<audio>` also plays it, since Chrome hands a received voice to Web Audio only then. A phone that will not start the sound without a tap shows "Tap to hear", as before.

What it costs, said plainly: the hiss between words is lifted too, by the same make-up gain — the threshold is no lower for that reason. Not on an iPhone or iPad (`G.mayLevelVoice`): a page's sound while its microphone is open is the phone's own business there, and a call has gone silent on one before for less; the voice plays as it came. Where Web Audio will not start, likewise. Tested in `test/remotevideo.test.js`.

## Headphones connected mid-call

Reported: Bluetooth headphones connected during a video call on an iPhone, and the other person went on coming out of the phone's speaker. On an iPhone a call's sound goes wherever its microphone is, and the call's microphone was the phone's own — opened when the call began, before the headphones arrived. Headphones connected before the call were never a problem: the call opened theirs from the start.

So while a call is on, a change in the phone's microphones opens the microphone again (`followAudioDevice()`), which picks whatever the phone now prefers, and swaps it into the call's sender with `replaceTrack` — no new call. The sound follows it. Taking the headphones off works the same way, back to the phone.

- **Only microphones count.** The list of audio inputs is noted when the call's own microphone opens, and a `devicechange` that leaves it as it was — a camera, say — does nothing. Phones fire the event more than once for one connection, so it acts once things settle.
- **Nothing is followed until that list is noted.** It is `null` while a call's devices are starting and between calls. It used to start as `""` and was never cleared, so a phone reporting a change just as its camera and microphone started was compared with the last call's list, or with nothing, and the call's devices were opened again in the middle of being set up. Reported as a laptop that could hear the phone but never saw it.
- **The new microphone is opened before the old one is stopped.** If it will not open, the call keeps the sound it had.
- **It asks `G.mayMoveMic`** — a call that is on, with a microphone in it, nothing else changing its devices — and checks the call again once the microphone has opened. It shares `restartingCallMedia` with the camera flip and the restart after a lock. Muted stays muted.

Whether the sound then reaches the headphones is the phone's doing; the page has no say over where sound goes on an iPhone. This was checked in a browser with stand-in devices, not on a phone with real headphones.

### Back to the loudspeaker

Reported next: with headphones taken off mid-call, the sound landed on the iPhone's quiet **earpiece**, as for a voice call, with no way back — while a video call started without headphones was on the loudspeaker and fine. The microphone had been opened again alone, and on its own the phone treated it as a voice call.

**A page cannot choose the loudspeaker over the earpiece on an iPhone** — no browser there offers it. What a page can do is what happens as a video call starts, which is when the phone picks the loudspeaker: stop the call's microphone and camera altogether and open both again (`restartLikeCallStart()`), swapping them into the same senders. Two things do that:

- **Headphones coming off in a video call** (`G.micChangeAction` → `"mic-and-camera"`: fewer microphones than before, and a camera in the call). Headphones arriving still open the microphone alone — that works, and does not blink the picture.
- **The loudspeaker button**, for whenever the sound is quiet. Only on an iPhone or iPad, only in a video call (`G.speakerOffered`): a voice call has no camera to open, and opening one would be capture nobody agreed to.

Everything is stopped *first*, unlike the microphone-only move: the phone decides where the sound goes when the capture starts, and it has to start. The cost is a moment without sound or picture while both come back. Muted stays muted, camera off stays off, and it shares `restartingCallMedia` with the flip and the restart after a lock. If they will not open, the tracks are left ended and coming back to the page tries again.

It is the phone's decision in the end. If an iPhone keeps the earpiece after this, a page cannot overrule it, and the button should go.

## Silence from an iPhone

Reported: an Android phone heard nothing at all from an iPhone in Safari — from the start of the call, voice or video, now and then — while the iPhone heard the Android phone. Not something that could be tried here on a real iPhone, so the likely causes were closed and a readout added that tells them apart.

- **The sound has a line of its own in the call's figures** (`DCS.callAudioStats`, in a voice call too): "Sound ↓ 32 kb/s 12% · ↑ 30 kb/s 4%" — the rate each way, and how loud. Nothing arriving reads "↓ —" or 0 kb/s; a microphone sending nothing but zeros reads exactly "0%"; a quiet room "<1%". Next time it happens, the two phones' lines say which end and which fault.
- **A microphone the phone has paused is woken** (`G.micCheck`, `checkMic` in `app.js`). A phone can pause a page's microphone without ending it: the track says it is muted (by the phone — the person's own mute only switches it off), or it stays live and sends zeros. Only a microphone that *ended* was ever started again. Now, while the call is on screen, one paused for a moment (1.5 s by the phone's flag, 4 s of zeros) is opened again as a call starts it — with the camera in a video call, so an iPhone keeps the loudspeaker (`restartLikeCallStart`). Zeros count only until the microphone has sent any sound at all: the fault was silence from the start, and once heard, quiet is someone being quiet.
- **Still silent after two tries, both sides are told.** This side shows "Your microphone isn't picking up sound — tap to try again" (the tap tries again); the other side is sent `call-mic` (sealed, like all call signalling) and shows "No sound is coming from the other person's microphone" in the call's note — so the silence is not taken for a fault at its own end. Back by itself, both notes go.
- **"Tap to hear"**: a phone may refuse to start the other person's sound without a tap of its own. That refusal used to be swallowed, a call connected in silence with nothing to press. Now a button appears in the middle of the call, and goes once the sound plays. An interrupted play (a fresh stream given) is not that.

Checked in two tabs with a stand-in microphone that sends pure silence: its side read "↑ 0 kb/s 0%", was opened again at about 8 and 16 seconds, then showed its note at about 22, and the other side showed "No sound is coming from the other person's microphone" with "↓ —"; given a working microphone, one tap on the note brought the sound both ways and cleared both notes. A real iPhone is still the test that counts.

## The other person's picture on an iPhone

Reported from an iPhone: sometimes, in a video call, the other person's picture stayed black — while their voice came through, your own picture showed, and they could see you. The call was working; the picture was never drawn.

The `<video>` used to be handed an empty `MediaStream` when the call began, and the other side's tracks were added to that same stream as they arrived. Safari — the engine of every browser on an iPhone — keeps playing the sound of such a stream but may never draw a video track added after the stream was attached. Whether it did depended on the order things happened in, hence "sometimes".

So the picture is never given a stream to grow. `showRemoteTracks()` hands it a **fresh** stream holding every track so far, each time one arrives, so the video is there from the stream's first moment. As a second line, when the video track starts receiving frames and the picture is still 0 pixels wide, it is handed over once more. A picture already showing is left alone — re-attaching restarts the player, a hiccup in the sound for nothing.

`test/remotevideo.test.js` runs the real code against a stand-in `<video>`; three of its tests fail against the old code. It cannot run Safari, so the fix is confirmed on a phone or not at all.

## A call that cannot start says so to both sides

Setting a call up can fail on either phone: camera permission refused, a camera another app is holding, a description the browser will not take. Every such failure used to end the call with `endCall(false)` — this side went back to the chat with "call failed", and **the other side was never told**. It sat on a dark "Connecting…" screen until someone pressed End.

Each of those paths now goes through `callSetupFailed()`, which sends `call-reject` so the other side closes its call screen too. Accepting the other side's answer (`handleCallAnswer`) had no `try` at all and is now inside one.

One subtlety holds it together: **the call is ended on every failure, but the other side is told only if it was still on.** Hung up while the camera was still opening, the failure arrives after the call is over. Ending it again is what turns that camera back off — skipping it would leave the camera running with no call — but the hang-up already told the other side, so a second `call-reject` is not sent. `test/client-source.test.js` runs `callSetupFailed()` both ways, and checks that every function that opens the camera or takes a description hands its failure to it.

## The chat during a call

A call used to cover the whole chat: nothing could be read, typed or sent, nor a file looked at, until it ended. The **chat button** among the call's controls (`#callChatBtn`) now makes the call small (`setCallMini`, the class `mini` on `#callOverlay`) — the other side's picture in the corner under the header for a video call, a strip with who it is for a voice call — and the chat works underneath: messages, files, pictures, voice notes. A tap on the small call, or its expand button, brings it back full size; its red button hangs up.

- **Nothing is stopped or restarted.** The small call is the same `#remoteVideo`, only smaller, so the picture and the sound go on throughout; the self-view, the status, the figures and the controls are hidden while it is small. The small call has nothing to fade, so `hideCallChrome` leaves it alone.
- **What arrives while the call fills the screen is counted** on the chat button (`noteCallChat`, called first thing by `noticeArrival` — someone looking at the call is not looking at the chat), and the controls come back so the count is seen. Opening the chat clears it.
- **A call ends full size.** `stopCallMedia` puts it back (`resetCallMini`), so the next call starts as calls always did.
- **The small call can be dragged** anywhere in the chat, by finger or mouse (`placeMini`), and stays where it is put — for the rest of the call and the next — kept inside as the chat changes size, a keyboard opening or a phone turned (`keepMiniInside`); the same sum as the self-view's, `selfViewPosition`. Its two buttons are for pressing, not dragging by, and `touch-action: none` keeps a finger on it from scrolling the chat underneath.
- **A tap is told by the finger lifting where it went down, not by `click`.** The finger is held (`setPointerCapture`) so a fast drag cannot slip off, and a finger held like that is sent no click at all — measured in Edge with touch: a tap on the small call did nothing. A press that moved less than 6px is a tap and brings the call back; a cancelled one is neither. The call comes back under the finger, so for a moment its buttons take nothing (`chrome-waking`): a mouse's click, which does follow, landed where End call now is and did not press it.
- **You are in its corner too.** A video call made small shows your own camera in its top corner, about a third of its width — the same picture as the full call's self-view, mirrored the same way — and hides it with the camera off (`cam-off`) or in a voice call. It takes no touches, so the small call still drags as one piece, and where you put the self-view in the full call is kept for when it is full size again (`keepSelfViewInside` leaves it alone while the call is small).
- **Six buttons fit across a phone.** An iPhone in a video call shows mute, camera, flip, loudspeaker, chat and end: 48px buttons on a phone, 44px under 360px wide, measured to fit 375px and 320px screens.

## A call nobody answers stops ringing

The other person away from the screen, or in another app, and nothing ended a call they never saw: the caller sat on "Calling…" for as long as anyone watched. A call now rings for `CALL_RING_MS` (45 seconds, in `guards.js`). If it is still only ringing then — not answered, not hung up (`callUnanswered`) — it is ended as a hang-up is, with `call-reject`, and the caller's chat says **"No answer"**. On the other side the incoming-call question goes away, and since it was still on screen when the hang-up arrived, the chat says **"Missed call"** rather than "Call ended". A caller who hangs up while it rings causes the same missed call.

An answer stops the ring (`initiateCallOffer`), and so does every way a call ends (`endCall`). The ring starts only once the call is placed. `test/ring.test.js` runs the block, `requestCall`, `endCall` and the `call-reject` case on a stand-in clock.

## One key exchange per channel

`e2e-pubkey` is accepted once. A second one used to re-derive the verification code while leaving the key actually in use untouched — so the code on screen stopped describing the key, the two sides displayed **different** codes, and the UI still said "verified". On a PIN join that code is the only thing standing between the user and a middleman, so a peer able to set it to anything empties it of meaning.

Re-keying is not a feature: a fresh channel runs a fresh exchange, and `e2eInit()` clears the flag. The flag is set the moment a key arrives rather than when its derivation finishes, because deriving is async and a second key arriving in that window is exactly the case worth refusing.

## Interrupted transfers say so, in both directions

A transfer that dies must not keep claiming to be running. Three paths cover it:

- the sender catches the failure, marks its own bubble failed, and sends `transfer-abort` if the channel is still up
- the receiver fails that transfer on `transfer-abort`
- both sides fail every in-flight transfer when the data channel closes

Before this, the peer leaving mid-transfer left the sender's bubble frozen at whatever percentage it had reached, permanently, next to an unhandled null-reference error. The receiver's bubble sat on "Receiving…" just as long. Neither side was told the file had not arrived.

## A received file is held to what it announced

The sending app refuses a file over 150 MB before it sends. The receiving app used to trust that and check nothing — but the other side can run a changed app, and in a room with no PIN the other side can be anyone. It could stream data until the phone filled up, or send a "picture" typed `text/html` that, opened from the chat, would load as a page from this site.

So the receiver now decides for itself (`incomingTransfer`, `presentAs` and `withinDeclaredSize` in `guards.js`):

| Check | When | What happens |
| --- | --- | --- |
| announced size over 150 MB | at `transfer-meta` | turned away before a byte is stored |
| more than 16 arriving at once, or more than 300 MB between them | at `transfer-meta` | turned away |
| an id, kind, size or chunk count this app could not have sent | at `transfer-meta` | turned away |
| one byte more than announced | as each chunk decrypts | cut off then, not at a `transfer-done` a changed app need never send |
| a chunk bigger than 64 KB plus IV and tag | on arrival | not decrypted, not parked |
| fewer bytes than announced | at `transfer-done` | failed, as a missing chunk already was |

Turning a transfer away frees what it held, says so in the chat, drops whatever more arrives under its id, and sends `transfer-abort`, which the sending app now obeys: it stops between chunks rather than sending the rest into nothing.

**The type the file is given is never the sender's.** A blob's type is what the browser treats it as when it is opened. A picture keeps its type only if it is a raster image (PNG, JPEG, GIF, WebP, AVIF, BMP, HEIC); a voice note only if it is `audio/…`. Everything else — an SVG, which can carry script, included — arrives as a plain download typed `application/octet-stream`, which no browser renders. The sender asks the same question, so an SVG picked as a picture is sent as a file and both sides show the same thing. A picture can be opened full size only once it has actually drawn; one that will not draw (a HEIC photo outside Safari) becomes a download link instead of a broken image.

## The Enter key, and messages on several lines

Enter always sent the message. On a phone — whose keyboard has no Shift to hold — a message could not have a second line, and the keyboard's ↵ key did the opposite of what it shows. Now (`enterSends`): **on a phone** (a finger for a pointer, `(pointer: coarse)`, asked at each press) Enter starts a new line and the send button sends; **on a computer** Enter sends and Shift+Enter starts a line, as before. The keyboard is told (`enterkeyhint`: "enter" on a phone, "send" on a computer), so the key it draws says what it will do. **An Enter that finishes a word still being composed** — Chinese, Japanese or Korean input — never sends; it used to send the half-written word.

And the lines arrive as lines. The bubble folded a message's line breaks into spaces, so even a Shift+Enter message from a computer arrived on one line; `.bubble` keeps them now (`white-space: pre-wrap`).

## Reactions

A message could only be answered with another message. Now any message — text, picture, voice note or file, either side's — takes one of six emoji (`REACTIONS`: 👍 ❤️ 😂 😮 😢 🙏). **Hold it** with a finger, or **right-click it** or use the small button beside it with a mouse, and a bar opens over it; the one picked shows under the message on both screens, picked again it is taken back (`nextReaction`), another replaces it. One each per message; the badge shows theirs and yours, "2" when they match (`reactionBadge`), and rings yours. Their reaction to your message is read out and noticed like a message (`noticeArrival`). The block is "REACTIONS" in `app.js`.

- **Both sides name the message the same way** (`reactionKey`): a text by its sender's number for it (`t:5` — the same number the delivery tick uses), a file, picture or voice note by its transfer id (`f:<uuid>`). A reaction says whose message it is (`mine`, from the reactor's side), since each side numbers its own texts.
- **Sealed, and checked.** A reaction goes in the encrypted envelope like everything said; `reaction` is not one of the types accepted in the clear, so whoever carries the packets cannot add one. One arriving is drawn only if it is one of the six, or none, on a message both can name (`reactionValid`) — a reaction is an emoji, never a way to put other words on screen.
- **Holding a message no longer selects its text on a phone**, nor opens the phone's own menu — the hold is the bar's. So the bar copies a text message (Copy). The lift after a hold is not a tap: it does not open the picture or follow the link it was held on. A finger that moves is a scroll, not a hold.
- **Not given unless sent.** With no channel to send it on, the reaction is not shown as given.

## Links in messages

A web address in a message was plain text, to be copied out by hand. It is now a link (`fillMessage`, the rule in `splitLinks`), opening in a new tab (`target="_blank"`, `rel="noopener noreferrer"`) so the chat stays where it is:

- **Only web pages become links** — `http:` and `https:`, or an address beginning `www.` — never `javascript:`, `data:` or anything else a message could hold. An address with a `name@` before its host is left as text: it reads as one site and opens another.
- **Shown as written, opening where it really goes.** Pointed at, a link says its real address (`title`). The sentence's punctuation stays the sentence's — "see example.com." — and a closing bracket stays with an address that opened one, as Wikipedia's do.
- **Built from text and `<a>` alone, never from markup**, so nothing in a message can become anything but words or a link. A message with no address is set as plain text, as before.

## Reading older messages

Every arrival scrolled the chat to the bottom — even while someone had scrolled up to read something earlier, so it was pulled away from under them. Now the chat stays put while they read, and a **"↓ New messages"** button over the message box says something came; it takes them down (`scrollBottom`). Reaching the bottom by hand puts it away too. What they send themselves — a message, a picture, a voice note, a file — still goes to the bottom, since they want to see what they sent (`scrollBottom(who === "me")`); a new chat starts at its newest.

## Messages have a limit, and say so

A chat message is at most **10 000 characters** (`MAX_MESSAGE_CHARS` in `guards.js`).

Before this, a long paste did nothing: Send was pressed, no bubble appeared, the text sat in the box, and nothing said why. A message goes as one data-channel message, sealed and base64-encoded, and two things broke past a certain size — `e2eEncrypt` spreads the sealed bytes into `String.fromCharCode`, which Safari refuses past 65 536 arguments, and the channel itself carries about 64 KB in one message in every browser. Either threw, and nothing caught it. At the worst case of 3 UTF-8 bytes per character, 10 000 characters is about 30 KB sealed and 40 KB on the wire; `test/message.test.js` checks both numbers.

- **Near the limit** a counter (`9500 / 10000`) appears over the box; **past it** the counter turns red and the box is marked `aria-invalid`. Nothing is cut off — a long paste stays whole, to be trimmed or split.
- **Pressing Send over the limit** shows a toast naming the limit. The text stays in the box.
- **Any other failure while sending** — the channel closing as Send is pressed — shows "Message not sent" and keeps the text, instead of an unhandled rejection.
- **The receiver holds the same limit**, since the other side can run a changed app: a longer message is not shown, not acknowledged, and a note says one arrived.

## Read aloud

Bubbles are drawn silently, so a screen reader found a new message only by going to look for one. `#srAnnouncer` is a visually hidden `aria-live="polite"` region, and `announce()` writes into it: each message from the other side ("New message: …"), each file, picture or voice note arriving, every system note, and the too-long warning. Your own messages are not read back. Only the last three lines are kept — it is a voice, not a history, and `aria-relevant="additions"` keeps the pruning silent.

## Pictures open in the chat

A picture in the chat opened in a new browser tab (`window.open` on its blob). On a phone that took the person out of the chat — the page behind it could be paused, the way the Back button used to lose a chat — and getting back meant finding the tab. It now opens in `#imageViewer`, over the chat and under the incoming-call question: fitted to the screen, a tap to zoom in two and a half times where it lands (the point tapped kept under the finger, a finger or the wheel to look round), a tap to fit again. **Save** downloads it under its own name; ✕, Esc, a tap on the dark round it (out of a zoom first), and **the phone's Back** close it — `backPress` answers `"close"` while a picture is open, so Back closes the picture as it would in any app and the chat stays, its next Back held as before. Leaving the chat closes it first, before the chat's pictures are let go of. Nothing in the app opens a new tab now; `test/viewer.test.js` fails if `window.open(` comes back.

## Paste or drop a file

The photo and file buttons choose **several at once** (`multiple`), sent one after another, each as the button said; the picker is emptied after reading it, so the same ones can be chosen again. On a computer a file reached the chat only through the paperclip menu. A picture pasted into the message box — a screenshot, Ctrl+V — is now sent as a picture, and files dropped on the chat are sent one after another, each finished before the next begins, each as what it is (`droppedKind`; `presentAs` still decides whether a picture is drawn as one). Text pastes as text. While files are dragged over the chat a dashed "drop to send" outline says where; it counts the edges crossed, so it does not flicker over the chat's own parts. **A file dropped anywhere else on the page no longer opens in the tab in place of it** — which, mid-chat, ended the chat.

## Voice notes every phone can play

Reported from an iPhone: voice notes sometimes showed "Error" in place of a player. Two reasons, both fixed in the recording code (`newVoiceRecorder` and the recorder's `onstop` in `app.js`, the rules in `guards.js`):

- **Every note was labelled WebM, whatever it was.** An iPhone records MP4, and Safari picks how to play a sound by its label, so it could not play its own notes; a computer recorded WebM, which an iPhone may not play at all. Notes are now recorded in the first of `VOICE_FORMATS` the browser can make — **AAC in MP4** first, which an iPhone records and Chrome and Edge do too — and labelled what they really are (`voiceType`, from the recorder's own word or its data's, never assumed), under a matching name (`voiceFileName`: `voice.m4a`). A browser that makes none of them (Firefox) records its own choice, and it is labelled as that.
- **A tap with a second tap straight after recorded next to nothing** — about a hundred bytes, measured in Edge, which plays nowhere — and it went out anyway, broken on both sides. A note shorter than `MIN_VOICE_MS` (one second), or with nothing in it, is not sent, and the sender is told it was too short (`voiceLongEnough`).

And a note this browser still cannot play — from a browser that records in a format this one does not know — becomes a line saying so, with a link to save it, rather than a player saying "Error" (`voicePlayer`). Checked in Edge, where notes now record as `audio/mp4;codecs=mp4a.40.2` and play on both sides; an iPhone itself was not available to test on.

## Telling you something arrived

A message, a file or a call that came while nobody was looking at the page — another tab, another app, another window in front — arrived in silence: no sound, nothing in the tab's title, and an incoming call rang nobody. The block "Telling you something arrived" in `app.js`:

- **A message, file, picture, voice note or missed call while the page is not looked at** (`unattended`: hidden, or on screen without the focus) gets a short two-note chime, a buzz where the phone has one, and a count in the title — "(2) Өртөө", or "(2) RelayLink" in English (`tabTitle`) — and on the installed app's icon (`setAppBadge`). The count goes once the page is looked at again. A burst of messages chimes once and counts every one. While the page is looked at, nothing.
- **An incoming call rings**, looked at or not — a phone left on the table with its screen kept on is the usual case — with a phone in the title and a buzz on Android, until it is answered, turned down or over. The caller gives up after `CALL_RING_MS`; the ringing gives up five seconds later on its own, as a missed call, so a hang-up lost on the way cannot leave it ringing.

The sounds are made with Web Audio — no sound files — and scheduled on the sound's own clock, which keeps time in a background tab where timers are slowed. A ring is cut by disconnecting its own output, which silences every ring still to come at once.

**What it cannot do.** No browser lets a page make a sound before it has been touched, so the sound is readied at the first tap or key; until then only the title counts. A page the phone has put to sleep — an iPhone with its screen off, or Safari in the background — runs none of this until it wakes, and Android ignores a buzz from a hidden page. Only a notification sent through a server reaches a phone in that state, which this app does not have.

## Only the handshake may arrive unencrypted

Two things travel on the data channel: frames in the clear, and an `e2e-dc` envelope that the agreed key seals. **Anything the app sends sealed is believed only sealed.** `handleTextMessage` takes a `sealed` flag that is true in exactly one place — where `e2eDecrypt` hands over what the envelope held — and asks `mayHandleFrame` before acting on anything.

| May arrive in the clear | Why |
| --- | --- |
| `e2e-pubkey`, `e2e-confirm`, `e2e-fail` | the ECDH handshake — there is no key yet |
| `pake-msg`, `pake-confirm` | the SPAKE2 handshake for a code room — also before any key, and only public values (a curve point, a tag) |
| `e2e-dc` | the envelope itself |
| `text` | carries its own ciphertext; `mayRenderText` drops it without one |
| `ack`, `typing`, `typing-stop` | nothing a watcher of packet timing could not already see |

Everything else — `transfer-*`, `call-*` — is refused in the clear.

**Who could send a clear frame?** Whoever is carrying the packets. A signaling server that swaps the transport fingerprints sits on the channel, and it can pass the key exchange through untouched, so the chat still reads as verified. It cannot open the envelope. It could write beside it: a clear `transfer-meta` drew a file bubble with any name it chose, a clear `call-request` raised the incoming-call prompt, and a clear `call-offer` after that was treated as the peer's. All of it kept working after `e2eFailClosed()`, which only disables **sending**.

The first fix for this covered `text` and nothing else. That is why the list says what **may** be clear rather than what must be sealed: a message type added later is refused in the clear until someone decides otherwise. `test/client-source.test.js` checks the list against the senders in both directions — a type sent clear but not listed would be dropped by the other side without a word.

## The microphone has one owner

A voice note opens the microphone, and opening is not instant. Two rules keep track of it, one each side of that wait:

- **A second press while it is opening does nothing** (`mayStartRecording`). `_isRecording` only turns true once the stream exists, so a double-click used to open two. The second replaced the first in the one variable that remembers it; the first could never be stopped and stayed live until the tab closed.
- **The room is checked again once it has opened** (`mayKeepMicOpen`). A permission prompt can outlast the room. The room's clean-up ran, found no stream yet, and the microphone then came on in the lobby with no button left to turn it off.

## Saved people

Talking to the same person again took a room made from nothing each time: a name typed, a kind picked, a link copied and sent through another app, and that link tapped. **Two people who have saved each other just tap the other's name in the lobby.** Whoever taps first waits; the second tap connects them, green, with nothing to type, send or compare.

**Saving** happens in a chat that is already checked — the shield green, by an invite link, a shared word or the code compared (`G.mayOfferSave`). Not in an amber one: the secret that saves them crosses that chat, and a middleman in it would be handed the key to every chat after. A line in the chat offers it; one side names the other and offers (`save-offer`, carrying a fresh 32-byte secret), the other is asked and names them back (`save-accept`) or says not now (`save-decline`, with a reason only ever used to pick one of our own sentences). All three are sealed and none is believed in the clear. Each device keeps, in `localStorage` under `dc-people`: the name it chose (its own; nothing the other side sends goes into it), the secret, the room's name, and which side of the pair it is — `a` offered, `b` answered. Saved only once both have said yes: a browser that cannot keep them turns the offer down rather than leave one side saved alone, and offers that crossed (both pressed Save) settle on the same one on both sides (`G.keepTheirOffer`). Fifty people at most; renaming and forgetting are this device's alone.

**Meeting.** The room's name is `~` and a SHA-256 of the secret (`DC.savedRoomName`), so both devices work it out alone and the server learns nothing it could join with. One message, `meet-session { sessionId, side }`, makes the room or joins it: the first makes it and waits in it, the second joins — so two taps at once cannot both make it. A saved person's room is:

- **never listed, with no PIN, no token and no link.** No room made by name may take such a name (`create-session` refuses it), and `join-session` is told it is not there.
- **entered only with the secret.** It is mixed into the key exactly as an invite link's is, and the host takes no key made without it (`G.mayUsePlainKey`): a seat taken by anyone else — a server that told someone the name, or took it itself — never opens. Checked in Edge: such a seat got "the encryption check failed", and no chat.
- **held by each side's newest copy.** The same side again — another tab, a reload, a page the phone closed — takes that side's seat, as a link opened again does, and the copy left behind is told (`seat-taken`) and stops: it never joins again by itself. If the waiting side's old copy was mid-chat, the other side starts again with the new one (`host-back` with `restart`); if the other side's own link was down too, its seat goes with that chat (its guest key takes nothing back), and a tap on the name gets in.
- **like any other room** for the rest: a host key and a guest key to take a seat back after a dropped link, ten minutes to wait, one room per socket, the same limit on rooms made from one network.

The waiting side waits **in the lobby, on the person's row**, with the screen kept on, until they come, Cancel is pressed, or ten minutes pass. The chat header and the voice call say the person's name (`roomTitle`), never the hash. A saved person's room is not kept for a reload (`saveHostRoom`): a page opened fresh meets them by a tap again, and the server gives it the seat.

What it costs, said plainly: the server sees the same room name each time the same two devices meet, so it can tell it is them again — not who they are, and not what they say. Anyone with the device in hand can open a chat as its owner, as with any app that stays signed in; Forget removes the person from that device. Each device saves separately: two computers and a phone are three saves. And Safari on an iPhone clears what a site keeps if the site goes about a week unopened — saved people with it — unless the app was added to the Home Screen, which it leaves alone.


**A call straight from the row.** Asked for: a voice or video call from a saved person's row, beside the envelope. The row shows a phone and a camera; either meets them as a tap on the name does — their room, a knock if they turned alerts on — and once the chat with them is up, places the call as the chat's own button would (`quickCallPerson`, `placeQuickCall`, `requestCall`): they are asked, as for any call. Not there yet, the row says the call starts when they connect; cancelling or leaving drops it. Both may press call at once, and two requests crossing would each turn the other away, so the guest calls a moment later — and not at all if the host's call already rings there. The host calls once the guest has introduced itself (peer-info), not the moment its own key is agreed: found trying it end to end, a call sent then overtook the confirmation that makes the guest ready and was dropped there — the host rang and the guest never heard it. Checked in two tabs that had each other saved: one pressed video call on the other's row, the other's lobby lit up, a tap on the name joined, "Incoming video call — accept?" came up, and accepted, the call connected with video both ways.

**Rename and Forget are out of sight until asked for.** Asked for: the pencil and the bin on every row were more than needed. A row shows the name and the envelope for messages; a right click on it — or a long press on a phone, or the keyboard's menu key — opens a small menu on the row with **Rename** and **Forget** (`openPersonMenu`, `holdForMenu`, `personMenu` in `app.js`). The name says how, when pointed at. A right click and the menu key are the browser's `contextmenu`, which Android also sends for a long press; an iPhone does not, so a touch held for half a second opens it too, and a finger that moves more than a little is scrolling and lets go of it. The click a long press's release can send neither meets the person nor closes the menu it just opened — found trying it in a browser: the name's click cleared the long press first, and the page's click then closed the menu. A tap anywhere else, or Escape, closes it; nothing opens while someone is being met or a row asks "Forget?".

## Knocks

Saving someone made meeting them one tap — if they opened the app too, and something else had to tell them to. Now **the first to tap knocks**: the other's device shows "Anu wants to talk", even with the app closed, and a tap on it opens the app and meets them.

- **Opt-in, per device.** "Turn on alerts", by "Saved people": the browser asks, the worker (`sw.js`) is registered — only then, never for anyone else — and the browser's push service gives a subscription for this server's key (`KNOCK_PUBLIC_KEY`, offered by `/api/ping`). On an iPhone in Safari the switch says how to add the app to the Home Screen instead, the only place iOS allows it. Refused in the browser: the switch says so, and where to allow it. `G.knockState` decides what the switch shows.
- **The address goes to the person, not the server.** Each side sends `knock-address` (the subscription's endpoint and keys, or `off`), sealed, right after saving and once each time they meet — so turning alerts on or off reaches each person the next time you connect, and at once if you are connected now. It is kept with the person (`G.savedPeople` keeps a well-formed one and drops a bad one, not the person) and shown as a bell by their name. The guest sends first and the host on hearing it, as with `peer-info`, so neither can overtake the key confirmation.
- **The knock.** First in their room (`session-created` for a saved room), the page sends `knock { sessionId, to }`. The server sends only for the host of a saved person's room while nobody else is in it; only to a push service's own https address — Google's, Mozilla's, Apple's, Microsoft's (`isPushEndpoint`), never wherever it was told; once per room in 20 seconds, 30 a network in ten minutes. The message is encrypted for that browser alone (RFC 8291, checked byte for byte against the RFC's example), signed (VAPID), lives ten minutes (the room's own wait), urgent, and a second replaces the first. It says only `{"t":"knock","room":…}`. The answer says whether it went; an address the push service calls gone (404/410) is forgotten.
- **The notification** is the worker's: it names the person by the name *this* device gave them, from a copy the page keeps in IndexedDB while alerts are on — rooms, names and the language, no secrets. A knock it cannot name says "Someone you saved wants to talk" (a browser requires every push to show something). Tapped, an open page is brought forward and told; otherwise the app opens at `#knock=<room>`, which the page reads, removes from the address, and meets.
- **Waiting for you shows on their name, in your lobby.** Asked for: a knock's notification was easy to miss with the app open, and with alerts off there was none. While your page is open it already asks after each saved person's mailbox under the room's own name and its side (`mail-fetch`), so the server says there when someone waits in that room for you, and when nobody does any more (`meet-waiting`, `tellSavedWaiting` — every room deletion goes through `removeSession`, so an ended wait is always said). Their row then stands out — a green edge, a ringing bell, "Wants to talk — tap to join" — and it is said once as a toast, with the chime if nobody is looking (`theyWait`). A lobby opened while someone already waits is told at once; a tap on the name joins them; each link that comes up asks afresh, so a wait that ended while it was down is not left showing. Only the side waited for is told, and the server learns nothing it did not know: it already sees which mailboxes a page asks after. Checked in two browsers' worth of tabs: saved each other, one tapped the other's name, the other's lobby lit up with the toast; a cancel cleared it, and a tap on the lit name connected them, verified.
- **Forgetting someone ends their knocks.** Found in a security assessment: forgetting took a person off this device and nothing more — they still held where to knock for it, and could go on making it say "Someone you saved wants to talk". A browser gives a device one address for everyone, so the only way to take it back from one person is to give it up: with alerts on, forgetting makes the address afresh and ends the old one (`renewKnockAddress`), which the push service then calls gone. Everyone still saved gets the new one the next time they connect, as after alerts are turned on; until then their knocks find the old one gone, and the toast says so. If the new one cannot be made, the old one is still ended and the switch shows alerts off.
- **It answers no requests** — no `fetch` handler, no cache — so updates arrive exactly as before. It is registered at `sw.js?v=<build>` and hashed into the build stamp, so it changes with the page.

Checked end to end in Edge, through Microsoft's real push service: alerts on, an address exchanged in a saved person's chat, that page closed, the other side's tap — the push service answered 201 and the worker showed "Anir laptop wants to talk" (in Mongolian), and opening as the notification would connected them, green.

What it costs, said plainly: the push service the browser uses carries each knock. It cannot read it, but it sees that one came, and when — and the server sees the subscription's address for the moment it sends. Nobody is knocked on who has not turned alerts on. On an iPhone the app on the Home Screen keeps its own storage, apart from Safari's: people saved in Safari are not in it, so save them from inside the app.

## Waiting messages

A chat needs both people there at once. **A saved person who is away can now be written to**: the message waits on the server — the Pi at home — until they open the app, and they can write back the same way. The envelope by each saved name opens the conversation and counts what is new from them; it is there while waiting for them too, for a word left instead.

- **Sealed before it leaves** (`DC.sealMail`, protocol.js): AES-256-GCM with a key the two devices work out from the secret only they share (`DC.mailboxKey`, HKDF labelled for this one use) — a secret the server has never had. Bound, as additional data, to where it belongs: the pair's mailbox, who wrote it, to whom, its id and its time. One handed back to its writer, moved to another mailbox, re-dated or changed does not open. The text never reaches the server, nor the secret; the room's name (a hash of it) is the mailbox's address, as for meeting.
- **Kept, not read** (`mailbox.js`): `mail-drop` leaves one (`{ box, to, id, at, iv, ct }`, and the recipient's knock address if they get alerts), kept once by its id however often it is sent; `mail-fetch` asks after a device's mailboxes and keeps the link listening to them; `mail-ack` lets them go. Kept in a file — on the Pi, the service's state directory (`StateDirectory=`, so `STATE_DIRECTORY`), or `MAILBOX_DIR` — written whole and moved into place, so a restart (every update is one) loses nothing; in memory only without either. A week, then gone unread. At most 100 messages or two million characters a mailbox, fifty million in all, 60 left from one network in ten minutes; whatever the file holds is checked again as it is read back.
- **Delivered**: whoever has the app open hears at once (`mail-waiting`), and fetches. Whoever is away and has alerts on is told "Anu sent you a message" (a push of `{"t":"mail","room":…}`, once a minute a mailbox) — not if they are there already. Tapped, it opens their conversation (`#mail=<room>`, or a word to the open page).
- **Taken here** one delivery at a time: opened with the pair's key as from the other side, to this one — or not shown at all — then the server is told it may let them go, opened or not. The ids taken are remembered (`G.MAIL_SEEN_MAX`), so a message delivered again is never shown twice, and one cleared never comes back. A message of ours goes again at each connection until the server says it has kept it, so one written with the link down is not lost; a refusal is said in our words (`G.mailRefusalKey`).
- **Kept on the device** (`dc-mail`, checked by `G.mailStore` as it is read): each person's conversation, up to `G.MAIL_THREAD_MAX` messages. Clear takes two taps; forgetting someone takes their conversation with them.
- **Photos and files wait too** — the paperclip in the conversation, up to 50 MB each (`G.MAIL_FILE_MAX`; the server says its own limit in `/api/ping` as `mailFileMaxBytes`, 0 when it keeps none). The file is sealed whole with the same key (`DC.sealMailFile`: AES-256-GCM, bound to the mailbox, who, to whom and the message's id) and sent first, over the web rather than the link: `POST /api/mailbox/file`, named in an `X-DC-Mail: box:side:id:size` header — never in the address, which can be written down along the way. Then a message of its own describes it — `{ file: { name, type, size } }`, sealed like any other, sent with `file: true` — and the server takes the two together; a message for a file never sent is refused. The other device takes the message, fetches the file (`GET`, the same header without the size), opens it, and only then says it has it — no answer, and it is fetched next time; gone or not opening, it is said lost, once. On the server each file is written straight to disk as it comes, counted (one longer than it said is cut off), named by a hash that says nothing of whose it is, and goes with its message; one sent and never described goes after ten minutes. 400 MB a mailbox, 2 GB in all, 40 sent from one network in ten minutes, three coming at once. On the device the copies are kept in IndexedDB (`dc-mail-files`), each only ever typed as `G.presentAs` allows — a photo is drawn, tap to see it big; anything else, an SVG included, is a file to save, never opened as a page.

What it costs, said plainly: the server sees which mailboxes a device asks after — so which saved pairs it belongs to — and when messages come and go, and how long they are; never what they say. That server is the Pi at home now. There is no forward secrecy: a message is sealed with the pair's lasting key, so whoever later had that secret and a copy of the sealed message could read it — which is why the server lets each go once it is taken. And a device that is offline for more than a week misses what waited for it.

## Notes for the owner

"Leave a message" emailed the app's owner through a mail company (Resend), which read every word — and the attachment. **Now a note is sealed on the visitor's device to the owner's lock, and only the owner's devices open it.**

- **The lock** is two public keys (`DC.OWNER_LOCK` in `protocol.js`): `box`, which anyone seals to — ECDH with a one-time key of the sender's own, HKDF, AES-256-GCM, so the sender cannot open it again either — and `sign`, which the server checks the owner's proof against. It is written in the app's own code, not handed out by the server: a server that was taken over could not slip in a lock of its own and read what visitors write next. Until it is set, nobody can leave a note, and the form says so.
- **The owner code** — 24 characters, 120 bits, from an alphabet with nothing to misread — is where both private keys come from (HKDF of the code, labelled for each key, brought into range as FIPS 186-5 A.2.1 does). It is made once, from "Own this app?" under the form, shown to be saved, and typed into each device the owner reads on. The keys exist only there.
- **Kept until the owner deletes them** (`mailbox.js`, its one `lasting` mailbox): in the inbox the lock names (`DC.inboxName`, side "a"), a file sent first as for messages, with no week — asked for, so that every one of the owner's devices has every note. Up to 200 notes (as many as a device keeps) and 1 GB of files; no file is taken that would leave the disk with less than 1 GB free (`DISK_RESERVE_BYTES`). The server cannot open them.
- **Only the owner's device collects them.** Each connection, the server's `hello` carries a word for that connection alone (`nonce`); the owner's device signs it with the lock's signing key (`owner-hello`, ECDSA P-256), and only then does the server hand it the inbox — the whole list each time, an empty one too, so a note deleted on one device goes from the others — let notes go when it says so, and take where to alert it (`owner-alert`, kept in `owner.json` beside the mailbox). A stranger fetching the inbox gets nothing, and one asking for notes to be let go lets nothing go.
- **On the owner's device** the Notes tab is the inbox itself — asked for: no button, no window. Day by day, newest first ("Today", "Yesterday", the date); a day opens to its notes — the time, who left it, the words — and closes again; a day with new notes opens by itself when the tab is looked at, and the tab carries a count of them. New and read go by when a note reached that device (`got`, `G.arrivedAt`), not the sender's clock. Each device keeps the words; a photo or file stays on the server until it is tapped, then is fetched, opened and kept there. Deleting a note (two taps) or clearing them all deletes them from the server — for every device — and is said again until the server's list shows them gone (`deleting`). "Inbox settings" shows the code again, or takes it off the device: the notes kept there go with it, and stay on the server for the owner's other devices.
- **A note can carry the sender's location.** Under the form a box — **Include my location**, ticked by default — attaches where they are: in an emergency, when the two cannot be live at once, a note left with its place says enough. Ticked, the browser asks for the position before the note is sealed (the location travels inside the sealed note, `loc` in `DC.noteBodyValid`, never in the drop the server sees); unticked, nothing is asked; denied or unavailable, the note still goes without it. The owner's inbox shows it as a map link. The sender chooses each time, and sees the box — nothing is taken quietly.
- **Limits:** 10 notes from one network in ten minutes, a note's words up to 5000 characters, a file up to the server's file limit less what sealing adds (`DC.NOTE_SEAL_EXTRA`).

What it costs, said plainly: the owner code is the inbox. Lost, the notes waiting can never be read — a new code needs a new lock in the app. Seen by someone else, they can read every note left since. The server still sees that a note was left, when, from which network, and how long it is. Notes stay on the server, sealed, until the owner deletes them — so a code seen by someone else later still opens every note kept there; and the server has no backup of them yet.

Tested in `test/owner.test.js` (the code, the keys, the seal and the proof, each against node's own crypto, and a note carrying a location in range), `test/integration/notes.test.js` (through a real server: who may collect and let go, alerts, restarts, limits) and `test/people.test.js` (the page: setting up, sending, receiving, the inbox, a note's location sealed and drawn as a map link, taking the code off); and in headless Edge, a visitor's note and photo read in the owner's inbox, and a note's location shown as a map link.

## "Where are you?" — asked by the owner

Asked for: the owner, talking with their child, wanted to know where the child is right now — the place, and for safety the city and internet provider, the battery and the phone. **A map pin beside the shield asks; the other side chooses, every time.**

- **Only the owner can ask.** The pin shows only on a device whose owner code makes the app's lock, and only in a checked (green) chat (`G.mayAskWhere`, `drawWhereBtn` — redrawn with the shield and the code). Hiding the button would stop nobody, so the question itself is signed: `where-ask { nonce, sig }`, ECDSA P-256 with the lock's signing key over the chat's verification code and a one-time word (`DC.signWhereAsk`). The other side shows it only if `OWNER_LOCK` checks it (`DC.checkWhereAsk`); anything else is dropped without a word. Bound to the code, a signed question cannot be passed on into someone else's chat.
- **The other side chooses.** A line in the chat says who asks and what would be shared — location, battery, phone, network, and that the city and provider are looked up from their IP address — with **Share** and **Not now**. Not now sends only `where-decline`. An unchecked chat on their side is declined with its reason and shown nothing. The phone asks for the location itself as well.
- **Share** gathers what this phone can say (`whereAboutHere`): a fresh, precise position (`enableHighAccuracy`, 20 s), the battery (`getBattery`), the model and system version (`userAgentData`, Android's Chrome), the network type and speed (`navigator.connection`), the language and screen size. Each part is asked on its own, and one the browser does not have is left out, never guessed — an iPhone gives no battery, model or network type. It goes back sealed as `where-answer`.
- **Quiet on the responder's screen.** The one who shared sees only a small **"Shared"**, not the location (`drawWhereShared`), so someone glancing at the phone cannot read it — and they can tap **See what you shared** to draw the card and check exactly what went. The screen is quieter; nothing is hidden from the person who shared.
- **The owner's card** keeps only an answer to the question it asked (the word must match, once), held by `G.whereAnswer` to what each part may say — the model and language are the other phone's own words, so they are held to letters, digits and a few marks, and everything goes in as text. The location has a map link. The city and provider come from the other side's address **as this side's own connection reports it** (`_lastAddresses`, never anything they sent), looked up by the owner's browser at ipinfo.io (`lookUpPlace`, `G.ipPlace`) — only for an address on the open internet (`DCS.isPublicAddress`), without cookies or referrer. The lookup is allowed in `csp.js` as `LOOKUP_ORIGINS`: for the page to reach, not an origin the server lets in. `server.js` allows the location for its own copy (`Permissions-Policy: geolocation=(self)`).
- **Only while the app is open.** A web page cannot track in the background, and this does not try: it is one answer, at that moment.

What it costs, said plainly: ipinfo.io learns the other side's address and the owner's, for each answer. The answer is only what the other phone says about itself. And whoever holds the owner code can ask — keep it as safe as the inbox it also opens.

Tested in `test/where.test.js`; checked in Chrome with two tabs — the pin on the owner's tab only, a question signed by any other key shown nowhere, and with the owner's lock the line, Share, the owner's card, the responder's quiet "Shared" with a tap to review, and the lookup reaching ipinfo.io through the page's own policy.

## Chat messages that wait for the link

A message written while the link is down used to fail. **Now it waits** (`outbox`, app.js): shown at once, faded, with ⏳, and sent by itself — in order, sealed as any other — as soon as the other side is listening again (`flushOutbox`, from `e2eActivate` and the host's `peer-info`). Only in a chat that had its key once (`G.mayQueueText`), up to `G.OUTBOX_MAX`; and a chat that was green waits to be green again before anything goes (`G.mayFlushOutbox`), so a message meant for a checked chat never leaves into an unchecked one. When the chat ends with some still waiting (`settleOutbox`, from the reconnect notice and from leaving), to a saved person they go as offline messages (✉, see "Waiting messages"); to anyone else they are marked not sent (✕) — never dropped silently.

**One sent but never confirmed waits too** (`takeBackUnsent`). When the other side's page closes, the link can look open for half a minute: a message sent then showed ✓ and went nowhere. Now each sent message's text is kept until its ✓✓ comes back; a new link puts the unconfirmed ones back in line, ahead of anything written since, and a chat ending over a broken link settles them with the rest. Leaving while the link is still sound takes nothing back — those have arrived, their ✓✓ just not back yet. Once in a while one arrived and only its ✓✓ was lost: it then shows twice, which is better than not at all. Tested in `test/message.test.js`, and in headless Edge with the other tab closed outright.

## Rooms: one per socket, and every message says which

- **A socket is in at most one room.** Creating or joining one lets go of any other (`cleanupClient`). A browser that opened a room and then opened or joined another used to keep hosting the first: it stayed in the lobby list with nobody behind it, and a guest who joined waited on a host who was elsewhere.
- **`peer-disconnected`, `guest-joined` and `session-expired` carry a `sessionId`**, and the client acts only if it names the room on screen (`mayApplyRoomEvent`). They used to name nothing, so when that abandoned first room expired, "the other side left" closed the live chat in the second.
- **An unjoined room that expires says so.** After ten minutes the host gets `session-expired` and the lobby replaces the PIN and link with a notice. It used to arrive as `peer-disconnected`, which wrote "peer left" into the hidden chat screen and left the lobby advertising a room that no longer existed.
- **A host cannot join their own room** (`own-room`). It is in the list like any other and the PIN is on screen; it used to be admitted, leaving one browser negotiating with itself.

## The same link opened twice: the newer copy takes the seat

Reported: a link sent through Messenger, opened by the guest, who then chose Safari — and was told the room was full. The link had opened first in Messenger's own browser, and that copy had taken the one guest seat. It stayed connected in the background, so Safari was refused; and when it finally dropped, a guest leaving deletes the room, so the invite was lost either way. The in-app notice holds the join until the person chooses, but "Continue here" joins, and an app that opens links in a Safari-based viewer is not detected at all.

The invite link is one person's. A second copy of it arriving is that person in another browser, so **a seat taken through the link moves to a newer copy of the link that someone is looking at** (`joinVerdict` → `"replace"`, in `ratelimit.js`):

- **Only a copy on screen takes the seat by itself.** The join carries `visible` — the page's own `document.visibilityState`, nothing more. The first version let any copy take the seat, and one nobody was looking at — a second Safari tab opened behind the first, an app's browser loading again in the background — took it from the Safari page the guest was using: the guest watched it say the chat had moved, and the host tried to connect to a page nobody had open. A copy in the background is refused with `held-elsewhere` instead, and so is a page too old to say.
- **Every copy without the seat offers "Continue here"** — the one that lost it (`seat-taken`) and the one refused it (`held-elsewhere`). Whichever copy the person is actually looking at, one tap makes it the one in use. Only the tap does: neither copy ever takes the seat back by itself.

- **The room is kept.** The guest has not left, only changed browsers. The server swaps the seat; the copy left behind is no longer the guest, so its socket closing later ends nothing.
- **The copy left behind is told** (`seat-taken`), says the chat moved to another browser, and **never joins with the link again by itself** (`inviteMovedAway`) — only through its "Continue here". Without that, the phone putting the app to sleep drops its socket, the reconnect re-sends the join, and the two copies take the seat back and forth for as long as both are open.
- **The host is told it is a new copy** (`guest-joined` with `replaced: true`): the old connection is let go of quietly, the chat on screen stays, a line says the other person reopened the link, and the connection starts again — verified, since the new copy carries the same room secret.
- **Only the link moves a seat taken by the link.** A guest let in by a PIN or by tapping an open room is not moved by the link, and a PIN does not move a link guest.
- **The same socket sending its join twice is not a second copy.** "Replacing" itself would run the guest-left clean-up on the room's own guest and delete the room; it is told "full", as before.

What it costs, said plainly: anyone holding the link can take the seat from whoever holds it through the link, mid-chat. That was already true of the first person to arrive — the link is the credential — and the host is told every time it happens.

## Join locks are for PINs, not invite links

Three wrong attempts lock an address out for 30 seconds; fifteen against one room lock the room for five minutes. Both exist to slow down guessing a 6-digit PIN.

**A correct invite token goes through both** (`joinVerdict` in `ratelimit.js`). The token is 192 random bits — nobody presenting the right one is guessing. Holding it to the PIN's locks protected nothing, and room names are public, so anyone could lock an invited guest out of a room they held a valid link to, for as long as they cared to keep it up.

**A correct PIN does not.** If a right PIN were admitted during a lock, the lock would stop nothing — the guesser would keep going until one landed. Someone can therefore still lock a room against PIN joiners; that is the price of a guess limit on a short code, and the invite link is the way round it.

**An open room is outside both locks**, for the same reason as the token: nothing is being guessed. And arriving at a PIN room with no PIN and no token is not a guess either — it gets `pin-required` and is not counted, where a wrong PIN is. Counting it would lock people out for looking.

Because nothing limits how often a token may be tried, both secrets are compared in constant time (`secretMatches`).

## The server's refusals, in the user's language

The server's refusals were shown as it wrote them, in English, to Mongolian readers too: a room name taken or not allowed, too many rooms from one network, and every refusal of a "leave a message" email. One of those passed on whatever the mail service said, as `detail` — its own English, and whatever it chose to include. (There is no mail service now: see "Notes for the owner".) Now:

- **Every refusal carries a `code`**, and the page says it in its own words: `serverErrorKey` for a room (`name-taken`, `invalid-name`, `too-many-rooms`), `leaveErrorText` for a note (`no-inbox`, `no-answer`, `too-many`, `full`, `too-large` with the size, `busy`, `off`; anything else, that it failed). A code the page does not know — a newer server — falls back to the server's message, and the reload notice, which has no code, is already in both languages.
- **The mail service's words stay in the server's log.** No answer carries a `detail` any more, and the page shows neither the server's English nor any detail.
- **Nine icon buttons were named in English only** — mute, camera, end call, leave, voice call, video call, attach, record, send — so a screen reader read them in English whatever the page's language. Each now takes its name from the page's language (`data-i18n-aria`), and `test/words.test.js` fails if an English-only name is left in the page.

## A browser that keeps nothing

With cookies blocked — a setting every browser has — merely reading `localStorage` throws, and some apps' built-in browsers have none at all. `i18n.js` read the saved language on its first line with nothing to catch that, so it threw, `I18N` was never made, and `app.js` stopped at its first word: the page looked as usual and nothing on it worked — no room list, no button. Reproduced in Edge with cookies blocked. The language is now read inside a `try`, where anything but `"en"` means Mongolian, and saved inside one, so with storage off the page works and only forgets the language when it closes. Every use of `sessionStorage` was already guarded. **Any new read or write of storage goes in a `try`.**

## One version in the browser at a time

**After changing any file a browser loads, run `npm run sync-build`.** The pre-commit hook refuses the commit otherwise.

This exists because of a bug that reached users. `index.html` loaded every script as `app.js?v=202608261800` — a stamp written once and never changed. GitHub Pages lets a browser keep each file for ten minutes, each on its own clock, and a tab left open keeps what it has for as long as it stays open. So after an update, three different things went wrong, all reproduced with a real browser cache:

| What the browser had | What the user saw |
| --- | --- |
| new page, old script | the new button is on screen and does nothing |
| old page, new script | the script reaches for an element that is not there, throws while loading, and **nothing** on the page works |
| a tab opened before the update | old code against the new server — a room with no PIN was drawn as one that needs one, asked for a PIN that did not exist, and nobody could get in |

It was reported as "the open-room button does not work and the other person cannot enter", and it would have happened again on the next change that added anything to the page.

Three pieces, one for each row:

1. **The stamp changes with the files.** `tools/sync-build.js` writes a build id — `202610131742-3fa9c1d2`, the time and a hash of every client file — into `const APP_BUILD` in `app.js` and onto every local file `index.html` loads. A new page therefore asks for addresses no browser has cached, and cannot be handed an old script.
2. **`app.js` checks the page it finds itself in.** Before it reads the invite or opens a socket, `refuseToRunInAStalePage()` compares the stamp it was loaded with against `APP_BUILD`. If they differ the page is the stale half: it fetches a fresh one and runs nothing. This cannot use `guards.js` or `i18n.js` — in a mixed page those are exactly the files that cannot be trusted to match.
3. **The server says which build it is.** Every socket is sent `hello` with the build on connecting, and every open page reconnects within seconds of the server restarting for an update. `updateAction` in `guards.js` decides: an idle page fetches the new build; one in a chat, joining, or part-way through typing waits until that is over; one that already fetched for this build says so rather than looping.

A fresh page is always fetched as `?r=<build>` — an address no cache has seen — and never by a plain reload, which can be answered from the same cache that held the stale copy. The invite rides along in the fragment, so it still never reaches a server.

Pages that predate all this cannot update themselves. The server recognises them — they ask for the room list without saying `hello` first — and sends the one thing they do display, an error message, asking for the page to be closed and reopened. That bridge can be deleted once those pages are gone; none survives being closed.

The server reads the id out of `app.js` rather than holding a second copy, and `npm run check-build` fails if the stamp no longer describes the files.

## Phone keyboards

On a phone the message box used to sit **underneath the keyboard** while you typed into it. Two causes, and both had to go:

- **Every full-height rule in `style.css` read `height: 100dvh; height: -webkit-fill-available;`.** The second declaration wins wherever it is understood — which is every phone browser — so the first never applied. All of them now read one variable, `--app-height`, set in one place.
- **Nothing watched the visual viewport.** That is the one measurement that actually gets shorter when a keyboard opens. On iOS, and in most in-app browsers (a link opened from inside a messaging app), no CSS unit does: the page stays full height and the keyboard simply covers the bottom of it. `fitToVisibleArea()` in `app.js` keeps `--app-height` equal to the visual viewport's height.

The viewport tag also carries `interactive-widget=resizes-content`, so Android Chrome and Firefox shrink the page themselves and need no script.

Three details that are easy to undo by accident:

- **Pinch-zoom is ignored.** Zooming shrinks the visual viewport too; resizing the page to match would fight the zoom.
- **A height of 0 is ignored.** A hidden tab reports one, and believing it collapses every screen.
- **Toasts are placed from the top of the visible area**, not from the bottom of the screen, which is behind the keyboard. Errors are shown as toasts.

Do not add a `height: 100vh` / `100dvh` / `-webkit-fill-available` to any rule — size it from `--app-height`. `test/layout.test.js` fails if one comes back.

**What has and has not been checked.** A headless browser at phone size, with the visual viewport reporting a keyboard, puts the message box directly above it (before: 286px below the visible edge). That exercises the code, not a real keyboard. It has not been run on a physical iPhone or Android phone from here.

## Tests

```
npm test
```

Node's built-in runner, no dependencies.

**`test/` is everything that runs without a server** — pure, and finished in under a second, so it all goes in the pre-commit hook. **`test/integration/` needs a real server** and runs before a push.

**GitHub runs them too** (`.github/workflows/tests.yml`): on every push to `main` and every pull request, `npm ci`, then `check-csp`, `check-build` and the whole of `npm test`, on Node 22 (the oldest `engines` allows) and 24 (what the Pi runs). The hooks only guard the machine they are installed on; two computers push here, so a push from one without them is still checked. The runners are on UTC, and the suite was run under `TZ=UTC` before this was added. The split is by directory rather than a list of filenames on purpose: `test:fast` used to name its files, and four pure test files were quietly left out of it.

**Each file there starts its server through `test/integration/serve.js`**, which waits up to 30 seconds for it — only as long as it takes — and, if it never comes up or ends first, fails saying so with what the server printed. Each file used to give it six seconds and throw its output away: after three updates in a row the first full run failed every server test at once and the next passed, with nothing to say why — most likely a slow start while the rest of the suite ran beside it and the new files were still being scanned.


- `test/protocol.test.js` — invite-link parsing (including malformed input, which must not throw at page load), room secrets, key derivation, and the framing. Includes a man-in-the-middle case asserting that an attacker who substitutes both public keys cannot reach a working key without the room secret. With the real AES-GCM, what each seal is bound to: a message opening only as its own side, number, type and id, a chunk only for its own transfer and place, a key confirmation not opening when handed back; and `takeSeal` taking each number once, a little out of order, nothing too far behind, and nothing that is not a counting number.
- `test/integration/server.test.js` — spawns a real server on port 3199 with a 1-second heartbeat: join rules, PIN lockout, an invite token getting through a locked room, open rooms (one guest, no PIN, never open by accident), one room per socket, room-name reuse, a peer that vanishes without disconnecting, the same link opened again (the seat moves to a copy on screen and not one in the background, the room stays, the copy left behind ends nothing), and a chat's seats kept through a dropped link (the guest key, never listed; each side taking its seat back; `peer-away` / `peer-back`; `repair-request` passed both ways; the seat full and unlisted meanwhile; expiry; wrong keys; a new link arriving before the old one closes; a leave still ending the room at once), a form holding no more than the page's own fields, and at most 50 open links from one address. Each client presents its own `X-Forwarded-For` so one test's rate-limit lockout does not leak into the next.
- `test/csp.test.js` — fails if `index.html` has drifted from `csp.js`, covers the framing rules above, fails if anything is loaded from another site, and checks the icon font served from here is the release's own.
- `test/ratelimit.test.js` — the sliding window, its expiry sweep, log sanitising, and every combination of `joinVerdict`'s seven inputs. The sweep has no external symptom until the process runs out of memory, which is why it is tested directly.
- `test/guards.test.js` — the safety decisions, every combination.
- `test/connstats.test.js` — which route ICE chose, link quality, byte totals, and which addresses are shown, with a plain Map standing in for the stats report. Also device descriptions, including that nothing a peer sends as one reaches the screen as it was sent.
- `test/shield.test.js` — the shield and its panel, lifted out of `app.js` and **run** against stand-in elements: what sentence, addresses and devices end up on screen in each state. Added because a text-level check passed while the "who can read this" sentence was never being redrawn.
- `test/pake.test.js` — SPAKE2: every step against the official RFC 9382 test vector (`pA`, `pB`, the shared `K`, the transcript, the derived keys, both confirmation tags), plus matching words reaching one key, and wrong words, tampered messages and invalid points failing.
- `test/author.test.js` — the author at the top left: the photo as a button named in both languages, the name and a few words, nothing private (no address, phone, degree or workplace), the three links opening safely and named for a screen reader, the photo small and served and part of the build, and the panel's closing — a tap elsewhere, opening the other, Escape — lifted out of `app.js` and run.
- `test/build.test.js` — the build stamp: that it still describes the files, that every local file carries it, and `refuseToRunInAStalePage()` lifted out of `app.js` and run against a stand-in page.
- `test/chatrepair.test.js` — a chat surviving a dropped link: `G.chatRepair` in every case, then the repair lifted out of `app.js` and run with a stand-in clock, connection and server link — the host offering and the guest asking at two seconds and every six, stopping once back up, waiting while either seat is away and going at once when it is back, each side's seat taken back with its own key (and the room taken as gone without one), the host acting on an ask but not twice in three seconds, a seat refused ending the chat only if its link has failed too, and nothing repaired once the chat's channel has closed.
- `test/callrecovery.test.js` — a call whose link drops: `G.callRecovery` in every case, then the recovery lifted out of `app.js` and run with a stand-in clock and connection — the caller asking for a fresh route after three seconds and every eight, stopping once back up, waiting for the chat's channel, both sides giving up at half a minute and saying so, the answer on the same connection, and a stray answer changing nothing; and the chat's channel closing mid-call — the real close handler run — ending the call at once and saying so before that they left, a call still ringing here counted as missed, and nothing said of a call when there was none.
- `test/callchrome.test.js` — the call's controls stepping aside: `G.callChromeMayHide` in every case, then `showCallChrome()`, `hideCallChrome()` and `stopCallChrome()` lifted out of `app.js` and run with a stand-in clock — fading after four seconds, coming back on a touch, the waking tap pressing nothing, staying while connecting or in a voice call or in use, a phone's leftover hover, and the CSS that makes faded mean untouchable.
- `test/rotation.test.js` — upright pictures only: `withoutRotationExtension()` and `setCallLocalDescription()` lifted out of `app.js` — the video-orientation extension taken out and nothing else, the original given back to a browser that refuses the change, both the offer and the answer going through it — and the away note moved under the figures.
- `test/callstats.test.js` — what a video call receives and sends: `DCS.callVideoStats` against a plain Map — format, size, frames a second, the rate from the last reading, arriving but not decoded, no video either way, and that a call reads it while it lasts; and the sound: the rate and level each way, the level worked out from energy where a browser gives no audioLevel, nothing to read being no error, and the call's figures carrying the sound on a line of its own and feeding the microphone check.
- `test/codecs.test.js` — the call's video format: `h264First()` and `preferCallVideoCodecs()` lifted out of `app.js` and run against stand-in transceivers — H.264 to the top with everything else kept as the fallback, the sound untouched, a browser that refuses a preference left to its own, and set before both the offer and the answer.
- `test/screenshare.test.js` — screen sharing: `G.mayShareScreen`, `G.shareOffered` and the flip refusing while sharing, then `startScreenShare()` and `stopScreenShare()` lifted out of `app.js` and run against a stand-in screen and camera — the same sender, the camera stopped only once the screen is in, the picker closed, a hang-up mid-picker, the browser's own Stop sharing, the camera coming back as it was or not at all.
- `test/headphones.test.js` — where a call's sound goes: `G.mayMoveMic`, `G.micChangeAction` and `G.speakerOffered`, then `followAudioDevice()` and `restartLikeCallStart()` lifted out of `app.js` and run against stand-in devices — only a change in microphones counts, the same sender, the old microphone stopped only once the new one is in, muted kept, a hang-up mid-open, a microphone that will not open.
- `test/flipcamera.test.js` — the camera flip: `G.mayFlipCamera` and `G.flipCameraOffered` in every combination, then `flipCamera()` and `updateFlipCamBtn()` lifted out of `app.js` and run against stand-in cameras — stopped before the other opens, the same sender, a hang-up mid-open, a camera that refuses, only the front mirrored.
- `test/selfview.test.js` — the self-view: that only it is mirrored and only by the stylesheet, and `selfViewPosition()`, `moveSelfView()` and `keepSelfViewInside()` lifted out of `app.js` and run against stand-in elements — past every edge, a phone turned on its side, a hidden call; and the swap: a tap showing yours big with theirs small where yours was, a tap on theirs swapping back, a drag or a cancelled press swapping nothing, yours big neither dragged nor swapped, none in a voice or small call, and the stylesheet's two places.
- `test/remotevideo.test.js` — the other person's picture: `createCallPeerConnection()`, `showRemoteTracks()` and `playRemoteCallMedia()` lifted out of `app.js` and run against a stand-in `<video>` and connection — never an empty stream to start, a fresh stream per arriving track, a blank picture re-attached when frames arrive, a showing one left alone; and "Tap to hear" appearing when the phone refuses to start the sound, going once it plays, and not for an interrupted play.
- `test/i18n.test.js` — both languages have the same keys, every key `app.js` asks for by name exists in both, and every `data-i18n`, `data-i18n-ph` and `data-i18n-aria` key in `index.html` does too, since a missing one falls back silently. That `i18n.js` loads with storage throwing, missing or holding nonsense, and that switching language works with storage blocked. Also that the page opens straight to the lobby, and that on a phone the title row sits below the fixed language switcher rather than under it.
- `test/awake.test.js` — a locked screen: `serverLeaveEndsChat` and `linkLostForGood` for every link state, and the `peer-disconnected` case, the ICE state handler, `endChatLinkLost`, `showReconnectButton` and the keep-the-screen-on block lifted out of `app.js` and run — a notice that leaves a working chat alone, a failure that ends one only when the server cannot repair it, a wake lock taken, retaken on return and on a tap, and let go on leaving.
- `test/callpause.test.js` — a call across a locked screen: `tracksToRestart` and `callPauseNote`, and the block lifted out of `app.js` and run against a stand-in call — the other side told on hide and return, ended tracks reopened and swapped in place, mute kept, a hang-up during the reopening putting everything back, one reopening at a time, a limit on retries, and the note's three states; and a microphone the phone has paused: `G.micCheck` in every case, then `checkMic` and `noteMicLevel` run with a stand-in clock — opened again twice, then said here and told there, back by itself clearing both, the note's tap trying again, zeros counting only before the microphone has been heard, and the person's own mute left alone.
- `test/reactions.test.js` — reactions: `reactionKey`, `reactionValid`, `nextReaction` and `reactionBadge`, and the block lifted out of `app.js` and run against a small stand-in page — sent sealed and shown, taken back and replaced, not shown as given when it could not be sent; theirs on your message shown, read out and noticed, theirs on their own shown quietly, "2" for the same; anything but the six, or a message not on screen, not drawn; a right-click and a held finger opening the bar, the lift after a hold not a tap, a moved finger or a mouse press not a hold; Copy for texts only; and the bar closing.
- `test/reading.test.js` — reading older messages: `scrollBottom`, its button and the scroll listener lifted out of `app.js` and run against a stand-in list — followed down at the newest, left alone while reading with the button shown, the button and a scroll to the bottom putting it away, your own messages always going down, and only your own bubbles forcing it.
- `test/viewer.test.js` — pictures opened in the chat, and files pasted or dropped: both blocks lifted out of `app.js` and run against stand-in elements — opened named and saveable, zoomed in where tapped and fitted again, the dark round it out of a zoom then closed, ✕ and Esc closing it and giving the focus back, nothing left opening a new tab; a pasted picture sent and text left to paste, dropped files sent one after another as what they are, the drop outline over the chat only while files are over it, text drags left alone, and a file dropped elsewhere kept from replacing the page.
- `test/words.test.js` — the server's refusals and the buttons' names in the user's language: every room refusal and every message refusal carrying a code and said in both languages, unknown codes falling back, no `detail` anywhere, and no English-only button name left in the page.
- `test/callchat.test.js` — the chat during a call: the block lifted out of `app.js` and run against stand-in elements — the chat button making the call small, a tap — told by the finger lifting, with no click — or the expand button bringing it back with its buttons briefly taking nothing, the red button hanging up, arrivals counted only while the call fills the screen, and the next call starting full size; dragging it with the finger held, inside the chat at every edge, a wobble still a tap, a cancelled press neither, its buttons not handles, the full call not draggable, and where it was put kept through a keyboard opening; the markup, what the small call hides and keeps, and six buttons fitting a 375px and a 320px screen.
- `test/voice.test.js` — voice notes every phone can play: `pickVoiceFormat`, `voiceType`, `voiceFileName` and `voiceLongEnough`, and the recording code lifted out of `app.js` and run against stand-in recorders — an iPhone's, Edge's, Firefox's, one that says it can and then will not, one that cannot be asked — each labelled what it made; a note under a second, or empty, not sent and said; and a note that will not play becoming a line with a link to save it.
- `test/attention.test.js` — telling you something arrived: `unattended` and `tabTitle`, and the block lifted out of `app.js` and run against a stand-in page, sound and clock — a chime, a buzz and a count while nobody looks and none while someone does, a burst chiming once, the count going once the page is really looked at, no sound before a tap, a sleeping sound woken, a ring that is cut whole and never starts after an answer, and a lost hang-up ending as a missed call. Also that the title names the app in the chosen language, and is renamed the moment the language is switched.
- `test/ring.test.js` — a call nobody answers: `callUnanswered`, and the ring block, `requestCall`, `endCall` and the `call-reject` case lifted out of `app.js` and run on a stand-in clock — given up after 45 seconds with both sides told, an answered call left alone, a hang-up stopping the ring, and a missed call said as one on the other side.
- `test/where.test.js` — "Where are you?": the question's signature against node's own crypto, refused for another chat, another word, a changed signature or any other key; `mayAskWhere`, `whereAskValid`, `whereAnswer` (each part dropped on its own when out of shape) and `ipPlace`; `isPublicAddress`; and the block lifted out of `app.js` and run as two devices — asked, Share, the owner's card and the responder's quiet "Shared" with a tap to review; a stranger's question and one passed on shown nowhere; an unchecked chat and Not now said back; location refused on the phone, an iPhone's missing parts, answers to no question or twice; the lookup only for a public address; asked again; Mongolian. Also that the three messages are sealed only, the order of checks before the line is shown, the button following the shield and the code, and the lookup allowed for the page alone.
- `test/preview.test.js` — the link-preview card: description, `og:*` and `twitter:*` lines present and agreeing, every address absolute and under the shared address with no fragment or query, and the picture on disk at the size the card claims, under 300 KB, served by `server.js`.
- `test/hostaway.test.js` — a room that waits for its host: `restorableHostRoom`, and the take-back block and its signalling cases lifted out of `app.js` and run — the room kept in this tab and taken up by a page opened fresh, a code room keeping its word, an invite page taking up nothing, broken or stale records thrown away, the reclaim carrying only the name and host key, and the guest waiting for the host. The server's half — rooms kept on a drop and not on a leave, the host key and nothing else taking them back, waiting guests, expiry — is in `test/integration/server.test.js`.
- `test/inapp.test.js` — opened inside another app's browser: `inAppBrowser` against the user agents Facebook, Instagram, Messenger, TikTok, LINE, Snapchat and WeChat really send, real browsers and our home-screen app left alone, the ways out for each phone, Safari handed the whole invite and Android never one with a fragment, and the hold and the notice lifted out of `app.js` and run — the invite kept and nothing joined while it is up, Copy link copying the whole invite, and Continue here joining.
- `test/back.test.js` — the phone's Back button: `backPress` and `chatIsLive`, and the Back-button block lifted out of `app.js` and run against a stand-in history — Back asking and staying on the page, Back again and Stay keeping the chat, Leave giving the entry back and never going past one that is not ours, an ended chat going to the lobby unasked, no entry before the first tap, and the close warning only while a chat is on; Back during a full-screen call making it small without asking, and asking once it is small; the X asking only when pressed by hand in a chat that is on, before it lets anything go; and a copy opened elsewhere leaving without asking.
- `test/codewait.test.js` — a code room through a wrong word, and a connection that cannot come up: `pakeFailClosed`, `returnToWaitingRoom`, the `guest-left` case and the connection watch lifted out of `app.js` and run — the host turning the guest away and waiting again with a note, our own closing kept from running the close handler, a failed attempt kept apart from an ended chat, ten wrong words locking the room for five minutes and a fresh count after, and the give-up note after thirty seconds with no channel. The server's half — seats freed, rooms kept, only the host turning a guest away, PIN and open rooms unchanged, and the upload limit — is in `test/integration/server.test.js`.
- `test/room.test.js` — the host's own room: `waitingRoomLost` and `isOwnRoom`, and `loseWaitingRoom`, `recreateRoom`, `createRoom` and `sendPendingCreate` lifted out of `app.js` and run — the lost room said and made again as the same kind, a code room keeping its word without sending it, a create kept while the link is down and sent once it is up.
- `test/install.test.js` — installing as an app: `installOffer` for each browser and the installed app, the button's block lifted out of `app.js` and run against a stand-in window (offer held, spent once, gone when installed; the iPhone steps open and close), and the manifest and icons read from disk — sizes, relative addresses, no see-through corners where the icon is cropped, and every one served by `server.js`.
- `test/lobby.test.js` — the lobby's tabs: the markup (three tabs, each naming its panel, Rooms open first, each section's controls inside its own panel, the status line outside them all), that nothing unrelated to creating is written into the Create tab, and `showLobbyTab()`, `lobbyTabKeyTarget()` and `renderSessionList()`'s room count lifted out of `app.js` and run.
- `test/message.test.js` — long messages and read-aloud: `sendTextMessage`, `updateMessageCounter`, `announce`, `appendBubble`, `appendSys` and the `text` case lifted out of `app.js` and run. The limit's arithmetic against the wire and Safari's argument cap; at the limit sent and shown, one past it refused on both sides with a reason; a failed send keeps its text; the counter's states; what is read out, what is not, and that the page carries the region. The Enter key: sending on a computer, a new line with Shift or on a phone, never mid-composition, the keyboard told which, and lines kept in the bubble. And links: web addresses in either side's messages made links that open in a new tab, shown as written and going where they really go, nothing but `http(s)` made one, and none built from markup; and a message sealed as ours with its number and id, opened only as the other side's at its own, a copy shown and acknowledged once, and one without a proper number not shown.
- `test/receive.test.js` — receiving files: the real `sendBinary`, `handleTransferMeta`, `acceptChunk`, `handleBinaryChunk`, `assembleTransfer` and the transfer cases of the message switch, lifted out of `app.js` and run as two sides against each other. Honest files, pictures and voice notes arrive whole and correctly typed; a changed app's oversized, overlong, short, mistyped or too-many transfers are turned away, and an honest sender that is turned away stops sending; and each chunk sealed as its sender's for its transfer and place — with a stand-in seal that, like AES-GCM, opens only with what it was sealed with — so a chunk delivered twice, swapped round, handed back or moved from another transfer fails the transfer, against a control where the same chunks in place arrive.
- `test/people.test.js` — saved people: `personName`, `savedPeople`, `mayOfferSave`, `saveOfferValid`, `keepTheirOffer`, `mayUsePlainKey` and `savedRoomName` (against an independent SHA-256), then the block lifted out of `app.js` and run against a stand-in page — the list, a tap and its one message, waiting and cancelling, the seat taken elsewhere, the offer and its answers in every order (crossed offers included), storage that keeps nothing, fifty at most, renaming and forgetting — and the wiring around it.
- `test/knock.test.js` — knocks: `encryptForPush` against RFC 8291's own example and against a decryption written from the RFC, the VAPID header verified with node's ES256, the keys from the environment, `isPushEndpoint` and `pushKeysValid`, `sendKnock` against a local push service (headers, the body opened, gone and failed answers); and `sw.js` run against a stand-in worker — named in the stored language, every push shown, English without the words file, a tap focusing or opening. `test/people.test.js` runs the page's side: the row's call buttons meeting them and saying the call will start, the host calling once the guest has introduced itself and the guest a moment later but not over a call already ringing, and a cancelled meeting taking the call with it; rename and forget opened by a right click on that row alone, by a long press after half a second but not a short tap, a moving finger or a mouse, its release neither meeting nor closing the menu, and closed by a tap elsewhere or Escape; someone waiting for us lighting up their row once and clearing when they stop, a tap on it joining, a stranger's room ignored, and each link asking afresh; the switch, turning alerts on and off, the worker's copy, the address exchanged and kept, the knock and its answer, opening from a knock, and forgetting someone making the address afresh (the old one ended, the others told when they next connect, nothing done with alerts off, alerts said off if the new one cannot be made). `test/integration/knock.test.js` spawns a server with keys and a stand-in push service: only the waiting host, only to a push service (a server that would answer is never sent to), once a room, gone said.
- `test/mail.test.js` — waiting messages: the seal opening for the other side only (not handed back, moved, re-dated or changed), the mailbox's checks, limits, week and file (a restart losing nothing, nothing in the file believed unchecked), and `G.mailStore`, `G.mailUnread` and `G.mailRefusalKey`. The page's side — sending, sending again until kept, opening theirs, forged ones dropped, two deliveries shown once, the conversation, clearing, forgetting, opening from an alert — is in `test/people.test.js`; `test/integration/mail.test.js` runs a server with a mailbox file and a stand-in push service — and, for someone waiting, the lobby of the side waited for told when it starts and stops, told at once when it opens late, its other devices told when one answers, and nobody else told. Photos and files: `test/mail.test.js` (their seal, checked against node's own crypto; the mailbox's file limits, clean-up and restart), `test/people.test.js` (sending, sending again, refusals, fetching, lost ones, drawing them, clearing), `test/integration/mailfiles.test.js` (through a real server: sent, described, fetched, let go, turned away, limited).
- `test/layout.test.js` — the phone-keyboard fix: that every full-height rule reads `--app-height`, and `fitToVisibleArea()` lifted out of `app.js` and run against a stand-in window for each case it has to judge.

The HTTP routes — `/api/ping` and the mailbox's files — are covered in `test/integration/mailfiles.test.js`. An async route would need its rejections caught: Express 4 does not await handlers, so a rejected promise becomes an unhandled rejection and Node exits, taking every open room with it.

**The WebSocket side has the same hazard and the same kind of backstop.** Nothing catches what a `"message"` listener throws, so it ends the process too — the four characters `null` did it, because `JSON.parse` accepts them and reading `.type` off `null` throws. `handleMessage` now rejects anything that is not a plain object, and the listener wraps it in a `try`/`catch` for whichever input nobody has thought of yet. New message handling goes inside `handleMessage`, not in a second listener.

Not covered: the WebRTC and UI code in `app.js`, which needs a browser and two peers. Changes there still want a manual two-tab check. Also not covered: the ten-minute expiry of an unjoined room — the wait is hard-coded, so it was checked by hand against a server with its clock moved forward.

### Ordering rules in `server.js`

All are about work done before a request has earned it.

**An upload is written straight to disk, counted, and checked before a byte is read** (`/api/mailbox/file`): the app's header, the mailbox and size it names, room in that mailbox and in all, the sender's allowance — and at most `MAIL_FILES_AT_ONCE` (3) coming at once. Nothing is held in memory, and one longer than it said is cut off. Before, "leave a message" took uploads through multer, which held each in memory, and needed limits of its own — on how many at once, and on the form's fields: one request of 150 text fields once took the process from 63 MB to 227 MB before being refused.

**At most `WS_PER_IP_MAX` (50) WebSocket links are open from one address** at once; the next is refused (429) until one closes. Found in a security assessment: nothing bounded them, so one machine could open thousands. Generous on purpose: a mobile network can put many phones behind one address.

**Anything client-supplied that reaches a log line goes through `safeLabel`.** A WebSocket `data.type` is arbitrary text up to `maxPayload`. Printed raw, a newline in it writes further log lines the attacker controls, including imitations of the real ones. Unknown types are also capped per socket, so one client cannot fill the log by inventing names.

### Framing (clickjacking)

`server.js` sends `X-Frame-Options: DENY` and `frame-ancestors 'none'`. **Neither reaches the GitHub Pages build** — Pages serves static files and sets no headers, and browsers ignore `frame-ancestors` in a `<meta>` tag. So on Pages, `framebust.js` is the entire defence.

It has two halves, and both are load-bearing:

| In `index.html` | What it does |
| --- | --- |
| `<style id="antiClickjack">body{visibility:hidden}</style>` | hides the page before anything renders |
| `<script src="framebust.js">` | reveals it only after confirming we are not in a frame |

That order makes it **fail closed**: if the script never loads, the page stays blank instead of becoming an invisible click target. Both must stay ahead of every other script, because `app.js` opens a WebSocket the moment it parses.

Inside a frame, `framebust.js` first tries to replace the framing page. Do not rely on that — Chrome refuses top navigation from a cross-origin frame without a user gesture, and an attacker picks the sandbox flags anyway. What actually protects the page is what follows: `window.stop()` halts parsing so `app.js` never loads, and the body is replaced with a notice.

Measured against a headerless static server standing in for Pages, framed in a sandbox that blocks escape:

| | without `framebust.js` | with it |
| --- | --- | --- |
| Scripts parsed | `protocol.js`, `i18n.js`, `app.js` | `framebust.js` only |
| Lobby rendered | yes | removed |
| Clickable controls | Approve, Create room, Send message | none |

`server.js` must keep serving `/framebust.js`, or the copy it serves itself 404s on it and every page stays hidden — `test/csp.test.js` checks that, along with the load order and the hide-first style.

### Icon font

The Tabler icons are served from here: `vendor/tabler/` holds release 3.31.0's stylesheet, its WOFF2 font and its MIT licence, exactly as published. They used to come from jsDelivr, which saw every visit — who opened the page, and when — and whose trouble took every icon with it. **Nothing on the page now comes from another site**, and the policy allows styles and fonts from `'self'` only.

- **The stylesheet is the release's own, byte for byte.** It still hashes to the integrity value the page used to demand of the CDN's copy (`sha384-XAeMOW3g…`), and `test/csp.test.js` checks that, so an accidental edit, or a re-save with other line endings, fails. `.gitattributes` keeps git from converting it (`vendor/tabler/** -text`).
- **Only the WOFF2 font is kept.** The stylesheet names WOFF2 first, and every browser this app can run in reads it; the WOFF and TTF copies (3.6 MB) exist for browsers far older than WebRTC. The test checks the font is a whole WOFF2 file, not an error page saved under its name.
- **The stylesheet is in the build stamp** (`tools/sync-build.js`), loaded as `?v=<build>` like every other file; the font is fetched by the stylesheet at its own `?v3.31.0`, and changes only with it. `server.js` serves both, or its own copy would show no icons.
- **Another version:** take the release's `dist/tabler-icons.min.css` and `dist/fonts/tabler-icons.woff2` from the npm package `@tabler/icons-webfont`, replace both, and put the new stylesheet's sha384 in the test. `test/csp.test.js` fails if anything is loaded from another site again — and if it ever truly must be, it needs `integrity` and `crossorigin`.

### Node version

`package.json` declares **`"node": ">=22"`**. Two reasons, and the second is the one that bites:

- `node --test` only accepts glob patterns from Node 21, and both test scripts rely on them — that is what keeps a new test file in the right suite by where it sits rather than by someone remembering to list it.
- **`engines` says which Node the server needs** (22 or newer), for any host that picks its own version — and can pick a different one on any redeploy.

22 rather than 21 because Node 21 is end-of-life. Nothing in the app itself needs anything newer than Node 18 — the floor comes from the tooling.

### Dependencies

```
npm audit
```

Worth running before a deploy. The server has two direct dependencies, and both sit directly on the internet — `ws` handles every signalling socket, `express` every request — so an advisory in either is reachable by anyone, not theoretical. The email ones (`resend`, `multer`) went with email, and their eight advisories with them.

Deliberately **not** in the pre-push hook: advisories appear on their own schedule, so it would block pushes for reasons unrelated to the change being pushed, and a hook that fails for unrelated reasons is one you learn to bypass.

### Git hooks

Tracked in `.githooks/` and wired up by `npm install` (via the `prepare` script). To enable them by hand after a fresh clone:

```
git config core.hooksPath .githooks
```

| Hook | Runs | Takes |
| --- | --- | --- |
| `pre-commit` | `check-csp` + `check-build` + `npm run test:fast` | ~1s |
| `pre-push` | `npm test` (adds the server integration tests) | ~7s |

The split keeps committing instant — a hook slow enough to be annoying is a hook you start bypassing. The slower half runs before code leaves the machine, which is the last moment a failure is free: pushing updates the Pi within two minutes and republishes GitHub Pages.

Bypass a single run with `git commit --no-verify` or `git push --no-verify`.

## Content-Security-Policy

The policy is defined once, in **`csp.js`**. It reaches the browser two ways and both are needed:

- `server.js` sends it as a response header (the copy it serves itself; also the only form that can carry `frame-ancestors`)
- `index.html` carries a `<meta>` copy, because GitHub Pages serves static files and cannot set headers

After editing `csp.js`, regenerate the meta tag:

```
npm run sync-csp
```

`npm run check-csp` reports drift and exits non-zero without changing anything — worth running before a deploy, since a stale meta tag only affects the static build and the server's own copy will look fine. The server also warns on startup if the two have drifted.

## Server configuration

Set **`ALLOWED_ORIGINS`** to a comma-separated list of every **browser origin** that loads the app and talks to this API (WebSocket + `fetch`). Examples:

- Static site on GitHub Pages: `https://YOURNAME.github.io`
- The server on the Pi, through Tailscale Funnel: `https://raspberrypi.vulture-manta.ts.net`
- Local dev: `http://localhost:3000`, `http://127.0.0.1:3000`

If an origin is missing, the browser will block CORS and **WebSocket connections will be rejected** during the upgrade (except non-production loopback without an `Origin` header).

Optional:

- **`PUBLIC_SESSION_LIST=0`** — the lobby never receives other users’ room names (only empty lists). Hosts still share PIN or invite link as usual.
- **`OWNER_LOCK`** — the owner's lock, where it is not the app's own (`DC.OWNER_LOCK` in `protocol.js`): for tests, or this server run for someone else. See "Notes for the owner".
- **`TRUSTED_PROXY_HOPS`** — how many proxies sit in front of this process (default **1**). Every rate limit keys on the client address, and `X-Forwarded-For` is only trustworthy as far back as the proxies you control, so the address is read that many entries from the **right**. Leave at 1 behind one proxy — Tailscale Funnel on the Pi, or nginx. **Set to 0 if the process is exposed directly** — otherwise a client can send its own `X-Forwarded-For` and pick a fresh identity for every request, evading the PIN lockout, the room-creation cap and the email limit. The server logs the value it is using on startup.
- **`HOST_AWAY_MS`** — how long a seat is kept for a side whose link dropped — a waiting room's host, or either side of a chat — in ms (default **600000**, ten minutes; accepted range 1000–3600000). See "A room that waits for its host" and "A chat survives a dropped link to the server".
- **`HEARTBEAT_MS`** — how often the server pings each WebSocket client, in ms (default **30000**, accepted range 1000–300000). A client that misses a sweep is dropped, which frees its room and tells the other peer. Lower it only for testing; every client answers every sweep, so short intervals mean constant traffic.

- **`KNOCK_PUBLIC_KEY`**, **`KNOCK_PRIVATE_KEY`** — the key pair knocks are signed with (Web Push, VAPID). Make them once with `node tools/knock-keys.js` and paste its two lines in. (It used to make, about one time in 250, a pair the server then turned away — node drops a private key's leading zero bytes — which switched knocks off without a word; the key is padded to its 32 bytes now. A pair already in use was taken, so is fine.) Without both, knocks are off: the server sends none and `/api/ping` offers no key, so the page shows no alerts switch. A new pair later makes every device subscribe again (it does so by itself when next opened) and tell each saved person again (when they next connect). See "Knocks".
- **`KNOCK_SUBJECT`** — a `mailto:` or `https:` contact the push services may use (default the site's address).
- **`KNOCK_TEST_ORIGIN`** — tests only: lets knocks go to one local stand-in for a push service. Never set it on a real server.
- **`HOST`** — the one address to listen on (default every address). Behind a proxy on the same machine, `127.0.0.1`: then nothing reaches the server except through the proxy, which is what `TRUSTED_PROXY_HOPS` relies on.
- **`MAILBOX_DIR`** — where messages waiting for someone are kept (`mailbox.json`), and their photos and files (`files/`). Defaults to the directory systemd gives the service (`STATE_DIRECTORY`, from `StateDirectory=` in `deploy/pi/direct-connection.service`); without either, they are kept in memory only and lost on a restart. See "Waiting messages".
- **`BASE_PATH`** — a path the proxy in front passes on without taking it off, such as `/dc`: the server takes it off itself before routing (default none; only a plain `/name` is accepted). The WebSocket answers on any path.

### On a Raspberry Pi at home

`deploy/pi/` runs the server on a Pi behind Tailscale Funnel — the app's one server; it never sleeps: a service running as its own user with nothing it does not need (`direct-connection.service`), listening on `127.0.0.1` in production; a timer that checks GitHub every two minutes and restarts it when there is something new (`update.sh`, installed as a fixed copy so what is pulled never runs as root, and npm installing with `--ignore-scripts`); and the settings file, whose secrets the person at the Pi fills in. `deploy/pi/SETUP.md` is the steps, written so Claude on the Pi can follow them, ending in checks that the public address answers, the live link opens through Funnel, and each visitor is seen by their own address rather than Funnel's. `test/deploy.test.js` keeps those files to what they promise; `test/integration/pi.test.js` runs the server with `HOST` and `BASE_PATH`.
