# Grove District — Staff Hub

Staff clock in and out, see their position for the day, and request time off.
Admins add staff, build the schedule, and approve leave.

Runs on Cloudflare Pages with a D1 database. Both are free at your size.

---

## Setting it up (about 20 minutes, no coding)

You only do this once.

### 1. Put these files on GitHub

Create a new repository on GitHub (you can make it **private** — Cloudflare can still read it).
Upload everything in this folder, keeping the folder structure exactly as it is:

```
grove-district-hub/
├── functions/api/[[path]].js   ← the server
├── public/index.html           ← the website
├── public/assets/logo.png
├── public/assets/logo-full.png
├── schema.sql                  ← sets up the database tables
├── wrangler.toml
└── README.md
```

The folder names matter. `functions` must sit at the top level, not inside `public`.

### 2. Create the database

In the Cloudflare dashboard: **Storage & Databases → D1 → Create database**.

Name it `grove-district`. Create it.

Open the database, go to the **Console** tab, paste in the entire contents of
`schema.sql`, and run it. That creates the tables.

### 3. Create the website

In Cloudflare: **Workers & Pages → Create → Pages → Connect to Git**.

Pick your repository, then:

- Framework preset: **None**
- Build command: leave **empty**
- Build output directory: `public`

Click **Save and Deploy**.

### 4. Connect the database to the website

This step is easy to miss, and nothing works without it.

Go to your new Pages project → **Settings → Bindings → Add → D1 database**.

- Variable name: `DB` ← must be exactly this, capital letters
- D1 database: choose `grove-district`

Save, then go to **Deployments** and click **Retry deployment** so the binding takes effect.

### 5. Create your admin account

Visit your new site (Cloudflare gives you a `.pages.dev` address).

The first time, it offers to create the first admin account. Enter your name and
choose a PIN. **Do this immediately after deploying** — the setup screen is open to
whoever reaches it first, and it locks itself permanently once one account exists.

Then go to **Admin → Team** and add your staff.

### 6. (Optional) Use your own domain

Pages project → **Custom domains → Set up a domain**. If your domain is already on
Cloudflare, this takes about a minute.

---

## Day-to-day use

**Staff see:** their position for the day, a clock in/out button, their own recent
hours, a form to request time off, and their own weekly schedule. Nothing else.

**Admins also get** an Admin tab: approve or decline leave, add and remove staff,
reset PINs, build the schedule, and view everyone's hours.

To put someone on a shift: **Admin → Build schedule**. Whatever you type in
**Position** is what that person sees on their home screen that day — "Cafe counter",
"Court marshal", "Front desk".

If someone forgets their PIN, an admin resets it in **Admin → Team → Reset PIN**.
That also logs them out everywhere, so they'll sign in fresh with the new PIN.

---

## Notes on how it's built

- PINs are never stored in readable form. They're hashed with PBKDF2 (100,000
  rounds). Even with full database access, the PINs can't be read back out.
- Every permission check happens on the server. A staff member can't reach admin
  functions by tampering with the page in their browser — the server refuses them
  regardless of what the browser sends.
- Admin status is re-checked from the database on every single request, so if you
  demote someone, they lose access immediately even if they stay logged in.
- Dates use Philippine time (UTC+8), so "today" is correct for your staff no matter
  where the server runs.
- Logins last 14 days, then staff sign in again.

## Things it deliberately doesn't do

- No password reset by email — an admin resets PINs by hand.
- No overtime rules, break tracking, or payroll export.
- Staff can't edit their own hours after clocking out; an admin would need to
  correct the database directly.

## If something breaks

**"Database is not connected"** — Step 4 was missed, or the deployment wasn't retried
after adding the binding. The variable name must be exactly `DB`.

**Page loads but nothing works** — Check that `functions` is at the top level of the
repository, not inside `public`.

**Setup screen won't appear** — An account already exists. Log in instead.
