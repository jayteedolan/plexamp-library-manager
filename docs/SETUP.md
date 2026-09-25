# Setting up Library Manager on the Raspberry Pi

This guide assumes a Raspberry Pi 4/5 running Raspberry Pi OS (64-bit), Plex Media Server installed
natively, and the music library on a USB drive. Commands are run on the Pi over SSH.

The layout used throughout (change the paths if yours differ — keep everything on the **same drive**
so moves into the library are instant):

```
/mnt/usb/Music              ← your Plex music library (Artist/Album/Tracks)
/mnt/usb/.lm/staging        ← slskd downloads land here until you file them
/mnt/usb/.lm/trash          ← the recycle bin
/mnt/usb/.lm/.lm-root       ← marker file: "the USB drive is really mounted"
```

`.lm` starts with a dot, and it sits *outside* the `Music` folder, so Plex never scans half-finished
downloads or trashed files.

---

## 1. Mount the USB drive reliably

Find the drive's UUID and filesystem type:

```bash
lsblk -f
```

Add it to `/etc/fstab` by UUID (not `/dev/sda1`, which can change). For ext4:

```
UUID=xxxx-xxxx  /mnt/usb  ext4  defaults,nofail  0  2
```

For exFAT/NTFS drives, ownership comes from mount options (use your own uid/gid from `id`):

```
UUID=xxxx-xxxx  /mnt/usb  exfat  defaults,nofail,uid=1000,gid=1000,umask=002  0  0
```

> exFAT/NTFS don't allow `: ? * " < > |` in names. Library Manager detects this and cleans up names
> automatically, but ext4 is the smoother choice for a Linux-only drive.

Then create the working folders and the marker file:

```bash
sudo mount -a
sudo mkdir -p /mnt/usb/.lm/staging /mnt/usb/.lm/trash
sudo touch /mnt/usb/.lm/.lm-root
```

**Why the marker?** If the drive ever fails to mount, `/mnt/usb` is just an empty folder on the SD
card. Without a guard, a download could silently fill the SD card. Library Manager refuses every
write while `.lm-root` is missing and shows a red "drive not mounted" banner instead.

## 2. Permissions (so both you and Plex can use the files)

Library Manager runs as your user (`PUID`/`PGID`) and creates files group-writable. Simplest setup on
ext4: make the files yours, with the `plex` group.

```bash
sudo usermod -aG plex "$USER"
sudo chown -R "$USER":plex /mnt/usb/Music /mnt/usb/.lm
sudo chmod -R u+rwX,g+rwX,o+rX /mnt/usb/Music /mnt/usb/.lm
sudo find /mnt/usb/Music /mnt/usb/.lm -type d -exec chmod g+s {} +   # new files inherit the plex group
id -u; getent group plex | cut -d: -f3    # → use these as PUID and PGID in .env
```

## 3. slskd (the Soulseek client)

**Check whether it's already installed:**

```bash
systemctl status slskd 2>/dev/null | head -3
docker ps --format '{{.Names}}' | grep -i slskd
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5030
```

A `200`/`401` from the last command means slskd is running. You also need a free
[Soulseek account](https://www.slsknet.org/) (slskd creates it on first login if the name is free).

Edit slskd's config (`slskd.yml` — typically `/var/slskd/slskd.yml` for a native install, or
`./slskd/slskd.yml` next to `docker-compose.yml` if you use the bundled container) and set:

```yaml
directories:
  downloads: /mnt/usb/.lm/staging
  incomplete: /mnt/usb/.lm/staging/.incomplete
shares:
  directories:
    - /mnt/usb/Music          # sharing back is good etiquette; many users won't upload to non-sharers
web:
  authentication:
    api_keys:
      library_manager:
        key: <a random string of 16+ characters>   # e.g. from: openssl rand -hex 24
        role: readwrite
        cidr: 0.0.0.0/0,::/0
```

Restart slskd afterwards. Put the same key in `.env` as `SLSKD_API_KEY`.

- **Existing native install:** `SLSKD_URL=http://host.docker.internal:5030`
- **No slskd yet:** use the bundled container. Set `SOULSEEK_USERNAME`/`SOULSEEK_PASSWORD` in `.env`,
  set `SLSKD_URL=http://slskd:5030`, and start it with `docker compose --profile slskd up -d`.
  Then add the `api_keys` block above to `./slskd/slskd.yml` and run `docker compose restart slskd`.

**Router:** for better download success, forward TCP port **50300** (the Soulseek *peer* port) to the
Pi. Don't forward 5030 or 8080 (the web UIs) — those stay private behind Tailscale.

## 4. Plex token and library

Your token is in Plex's preferences file:

```bash
sudo grep -o 'PlexOnlineToken="[^"]*"' \
  "/var/lib/plexmediaserver/Library/Application Support/Plex Media Server/Preferences.xml"
```

You can paste it into `.env` (`PLEX_TOKEN`) or later in the app's **Settings** page, where
**Test & list libraries** lets you pick the music library from a dropdown.

`PLEX_LIBRARY_PATH` must be the library folder *as Plex sees it*. Because the container mounts the
drive at the same path, this is normally identical to `LIBRARY_ROOT` (`/mnt/usb/Music`).

## 5. Install and start Library Manager

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker "$USER"     # log out and back in afterwards

git clone https://github.com/jayteedolan/plexamp-library-manager.git
cd plexamp-library-manager
cp .env.example .env
nano .env                           # PUID, PGID, paths, SLSKD_*, PLEX_*
mkdir -p data
docker compose up -d                # pulls the prebuilt arm64 image
# (or build on the Pi instead: docker compose up -d --build)
docker compose logs -f app
```

Optional hardening, so Docker waits for the USB drive after a reboot:

```bash
sudo systemctl edit docker
# add:
# [Unit]
# RequiresMountsFor=/mnt/usb
```

## 6. Remote access with Tailscale (instead of port forwarding)

```bash
curl -fsSL https://tailscale.com/install.sh | sh
sudo tailscale up
```

In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates** (DNS page). Then
publish the app to your tailnet over HTTPS:

```bash
sudo tailscale serve --bg 8080
tailscale serve status              # shows https://<pi-name>.<tailnet>.ts.net
```

Install Tailscale on your phone and laptop, sign in with the same account, and open that URL.
On the phone, use **Add to Home Screen** to get an app icon.

If you previously port-forwarded other tools on this Pi, remove those router rules for anything that
this replaces. Only the Soulseek peer port (50300) needs to be forwarded.

## 7. First run

1. Open the URL and create the admin account (only one account exists; there is no default password).
2. **Settings:** test the slskd connection, test Plex, choose the music library, and save.
3. The dashboard should show Plex, Soulseek and Storage as green.

Forgot the password?

```bash
docker compose exec app python -m app.cli reset-password
```

## Updating and backups

```bash
docker compose pull && docker compose up -d
```

The app's own state (account, settings, download history, trash index) is a small SQLite database in
`./data/app.db`. Copy that file to back it up. Your music is never stored there.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Red "drive does not appear to be mounted" banner | Check `mount \| grep /mnt/usb` and that `/mnt/usb/.lm/.lm-root` exists. |
| "Permission denied" when moving files | Re-run the permissions commands in step 2; check `PUID`/`PGID` in `.env`. |
| Soulseek "Cannot reach slskd" | Check `SLSKD_URL` (use `host.docker.internal` for native slskd) and that slskd is running. |
| Soulseek "rejected the API key" | The key in `.env`/Settings must match `web.authentication.api_keys` in `slskd.yml`. |
| Downloads never start / stay "Queued remotely" | The other user is busy or offline; try a result with a *free slot*. Forwarding port 50300 helps. |
| New albums don't appear in Plexamp | Press **Scan library** on the dashboard; confirm Plex can read the files (step 2). |
| Plex "rejected the token" | Tokens change if you sign out of Plex on the server; copy the new one from Preferences.xml. |
