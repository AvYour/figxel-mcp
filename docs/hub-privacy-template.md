# Privacy notice for [HUB NAME]

> **This is a template, not legal advice.** It is for whoever runs a Figxel hub, and it says what the hub software stores and for how long, as its code does it. It cannot know who you are, where your server is, what your host, your TLS proxy or your log collector keep, or which laws apply to you and the people who use your hub.
>
> Replace every `[PLACEHOLDER]`, delete what does not apply to your hub, add what your own servers and services do, and have the result checked by someone qualified before you publish it. Then delete this note, save your copy where the hub can read it, and set `BRIDGE_HUB_PRIVACY_FILE` to it: the hub shows it at `/privacy`, linked from its sign-in page ([docs/hub.md § A privacy page](hub.md#a-privacy-page)).
>
> The numbers below are the software's defaults. If you changed `BRIDGE_HUB_WEB_FOLDER_MB` or another limit, say so.

Last updated: [DATE]

## Who runs this hub

[OPERATOR NAME] runs the Figxel hub at [HUB ADDRESS] (here, "the hub", "we" and "us"). To ask about your data, write to [CONTACT EMAIL]. [If you have a data protection officer or a representative, name them here.]

The hub lets the Figxel plugin in your Figma and your AI apps reach each other through a server. It does not edit your designs by itself: your apps ask, the plugin in your Figma does the work, and the hub passes the requests and answers between them.

## What we keep, and for how long

### Your entry in our table of people

When we add you, or when you first sign in with Figma or Google, the hub keeps:

- **a name for you in the table**, which we choose, or which the hub makes from your email address (the part before the @) or from your account's name;
- **when you were added**;
- **a SHA-256 hash of your token**, never the token itself. If you signed up by signing in, you have a token too, which nobody is ever shown;
- **your email address**, when we set it or when you first signed in with an account whose provider says the address is verified;
- **the id Figma or Google uses for your account**, for each account you signed in with, so the next sign-in finds you.

We keep this until we remove you from the table. Removing you ends your invite, your signed-in apps, your remembered browsers and your plugin's sign-in at once.

### Signing in with Figma or Google

When you choose **Continue with Figma**, the hub asks Figma who you are with the `current_user:read` permission. When you choose **Continue with Google**, it asks Google with the `openid email profile` scopes. From the answer it keeps only what is listed above. It uses the access Figma or Google gives it once, to ask who you are, and does not store it.

### Apps you sign in to the hub

When an app (such as ChatGPT or claude.ai) connects with a sign-in:

- **the app's record**: the name it gives itself and the addresses it may return you to. We keep at most 500; when the list is full, the oldest app nobody is signed in with is removed;
- **a SHA-256 hash of the app's refresh token**, with your name in the table and the app it belongs to. It lasts 30 days and is replaced each time the app uses it;
- **the app's access token** is held in memory only, for an hour, and is never written to disk.

### Your browser

When you sign in on the hub's page, the hub sets one cookie, `__Host-figxel`, so the next sign-in in the same browser is one click. It lasts 30 days, scripts cannot read it, and it is sent only to the hub. The hub keeps a SHA-256 hash of it with your name in the table and how you signed in (Figma, Google or an invite). **Use another account** on the sign-in page deletes it. The hub sets no other cookie.

### The Figma plugin

When the plugin signs in through your browser, it receives a credential of its own. The hub keeps a SHA-256 hash of it with your name in the table. It works for as long as you are in the table with the same entry. [Say whether and when you delete the records of credentials that no longer work: the software leaves them in its file, where they open nothing.]

### Files

For an app connected to the hub by URL, the tools run on the hub, and the files they write (exports, videos, PDFs, frames of a video) are kept in a folder of your own on the server, together with any file you upload to import. Each file is deleted an hour after it was written; the download link to it also lasts an hour. Your folder holds at most [500] MB at a time. Nobody else's tools can read your folder.

### Logs

The hub writes a log, which [WHERE YOUR LOGS GO, AND FOR HOW LONG YOU KEEP THEM]. It names:

- the people in the table, by their name in it;
- the Figma files that connect, by file name;
- the apps that register and sign in, by the name each app gives, and how each person signed in;
- ids, sizes and timings;
- the network address of a client that the hub turns away for a while after too many wrong tokens, the web address of a page whose connection it refused, and the address of an app's description it could not read.

It never contains a token, an email address or what is in a design.

### In memory only

These are never written to disk, and are gone when the hub restarts:

- sign-ins in progress (10 minutes), codes given to apps (5 minutes) and the codes the plugin shows (10 minutes);
- counts per network address, to limit wrong tokens (up to 15 minutes), app registrations (an hour), reads of an app's description and sign-ins started by the plugin (10 minutes each);
- counts per person, to limit how many calls each person makes in a minute;
- for an app connected by URL, your sessions and what your agent has done so far (the guides it read, your brief, a video it is rendering), until 30 minutes after your last session ends.

## What passes through and is not kept

Your designs pass through the hub: the names of files, pages and layers, text, images and exports travel between the plugin in your Figma and your apps. The hub holds them in memory only while it passes them on, or, for an app connected by URL, while its tools work on them. It writes none of it to disk, except the files described above.

## Who else is involved

- **Figma**, when you sign in with Figma and wherever you use the plugin. [Link to Figma's privacy notice.]
- **Google**, when you sign in with Google. [Link to Google's privacy notice.]
- **Your AI app and its model provider.** Your app sends what its agent reads to that provider. That is between you and the app, not this hub. [Link to your app's notice, or delete.]
- **[HOSTING PROVIDER]**, which runs our server in [COUNTRY OR REGION]. [Add your TLS proxy, your DNS provider, your log or backup service, and anything else that sees traffic or stores data, with what each keeps.]

We do not sell your data, and we do not use it for advertising. [Delete or change this if it is not true for you.]

## Why we use it

[Write with someone qualified: why you process each kind of data above, and on what basis where your law asks for one. For example: to sign you in and keep your account; to pass your requests to your Figma; to keep the hub safe from abuse.]

## Your choices

- **To leave**, write to [CONTACT EMAIL]. We remove you from the table, which ends everything listed under your entry at once.
- **To forget this browser**, choose **Use another account** on the sign-in page.
- **To use Figxel without this hub**, run it on your own computer: in the plugin, choose **Use Figxel on this computer instead**.
- [Your rights where you and your users are, and how to use them: access, correction, deletion, complaint to a regulator. Have this written by someone qualified.]

## Changes to this notice

We will update this page when what the hub keeps changes, and change the date at the top. [Say how you tell people about a large change.]
