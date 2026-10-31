# SSH: Mac ↔ Windows VPS

## Mac: generate key (if missing)

```bash
ssh-keygen -t ed25519 -f ~/.ssh/gatc_vps -C "gatc-vps-mac"
# Enter a strong passphrase when prompted
```

Keep `~/.ssh/gatc_vps` private. Never commit or transmit it.

Display the public key to install on Windows:

```bash
cat ~/.ssh/gatc_vps.pub
```

## Mac: SSH config host entry

Add to `~/.ssh/config` (already correct for this project):

```sshconfig
Host GATC-VPS
  HostName 103.138.96.43
  User gatcdev
  Port 22
  IdentityFile ~/.ssh/gatc_vps
  IdentitiesOnly yes
  PreferredAuthentications publickey
  PasswordAuthentication no
```

Connect:

```bash
ssh GATC-VPS
```

## Cursor Remote SSH

1. Install the **Remote - SSH** extension in Cursor / VS Code.
2. Command Palette → **Remote-SSH: Connect to Host…** → choose `GATC-VPS`.
3. Open folder `C:\GATC\gatc-vps` after the window connects.

### Windows Remote SSH limitations

- Some Linux-oriented remote features are limited or unavailable on Windows SSH hosts.
- Prefer opening the project folder on the remote, not trying to use a full Linux remote environment.
- Terminal on the remote is PowerShell/cmd; portable tools live under `C:\GATC\tools\`.
- If the remote window fails to start a server, fall back to local Mac workspace + `ssh GATC-VPS` for VPS tasks.

## Windows: create `gatcdev` (RDP as Administrator, once)

In an elevated PowerShell on the VPS:

```powershell
$Password = Read-Host -AsSecureString "Password for gatcdev"
New-LocalUser -Name "gatcdev" -Password $Password -FullName "GATC Developer" -Description "GATC least-privilege SSH account"
Add-LocalGroupMember -Group "Users" -Member "gatcdev"
# Optional: allow Remote Desktop if needed
# Add-LocalGroupMember -Group "Remote Desktop Users" -Member "gatcdev"
```

Do not use Administrator for routine development.

## Windows profile path (important)

On domain/workgroup joined machines the profile may be:

`C:\Users\gatcdev.VPS`

not `C:\Users\gatcdev`. OpenSSH `authorized_keys` must be under the **actual** profile used by the SSH session (`$env:USERPROFILE`).

An orphan `C:\Users\gatcdev\.ssh` (if present) is harmless leftover from an earlier profile guess — do not delete system folders aggressively; leave it unless you are cleaning up deliberately.

## Windows: install public key

Still on the VPS (use the real profile; `${User}` must expand correctly in PowerShell):

```powershell
$User = "gatcdev"
$PubKey = "PASTE_PUBLIC_KEY_LINE_HERE"
# Prefer the live profile path from an interactive/SSH session as gatcdev:
$SshDir = Join-Path $env:USERPROFILE ".ssh"
# Or explicitly for this VPS:
# $SshDir = "C:\Users\gatcdev.VPS\.ssh"
New-Item -ItemType Directory -Force -Path $SshDir | Out-Null
$AuthKeys = Join-Path $SshDir "authorized_keys"
Set-Content -Path $AuthKeys -Value $PubKey -Encoding ascii

# Permissions: authorized_keys and .ssh must not be overly permissive.
# Use ${User} so PowerShell does not treat $(OI) as a subexpression.
icacls $SshDir /inheritance:r
icacls $SshDir /grant:r "${User}:(OI)(CI)F" /grant:r "SYSTEM:(OI)(CI)F" /grant:r "Administrators:(OI)(CI)F"
icacls $AuthKeys /inheritance:r
icacls $AuthKeys /grant:r "${User}:F" /grant:r "SYSTEM:F" /grant:r "Administrators:F"
```

Confirm OpenSSH is running:

```powershell
Get-Service sshd
```

## Portable tools (PATH)

Tools are installed under `C:\GATC\tools\`:

| Tool | Path |
|------|------|
| Node.js | `C:\GATC\tools\node\node.exe` |
| MinGit | `C:\GATC\tools\mingit\cmd\git.exe` |
| GitHub CLI | usually `C:\Program Files\GitHub CLI\gh.exe` (also fine on PATH) |

Persist for new `gatcdev` sessions (user env):

```powershell
$add = @(
  'C:\GATC\tools\node',
  'C:\GATC\tools\mingit\cmd'
)
$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
foreach ($p in $add) {
  if ($userPath -notlike "*$p*") { $userPath = "$p;$userPath" }
}
[Environment]::SetEnvironmentVariable('Path', $userPath, 'User')
```

`Restart-GATC.ps1` prefers `C:\GATC\tools\node\node.exe` so it does not depend on session PATH.

## Verify host fingerprint before first trust

1. Connect via RDP with credentials you already trust.
2. On the VPS, print the host key fingerprint, e.g.:

```powershell
Get-ChildItem C:\ProgramData\ssh\ssh_host_*_key.pub | ForEach-Object {
  ssh-keygen -lf $_.FullName
}
```

3. From the Mac, on first connect compare the presented fingerprint to the RDP-verified value before typing `yes`.

## Connectivity checks (Mac)

```bash
nc -vz 103.138.96.43 22
ssh -o BatchMode=yes -o PreferredAuthentications=publickey GATC-VPS "whoami"
```

If authentication fails, stop and diagnose — do not hammer password prompts.

## Network hardening (recommended)

Restrict inbound TCP/22 at the VPS firewall to your client public IP. Do **not** apply blindly — a wrong/changing IP locks out SSH. Keep RDP as a recovery path.

Prepared script (explicit run only):

```powershell
# Detect client IP from Mac first, e.g. curl ifconfig.me
cd C:\GATC\gatc-vps
.\deployment\Restrict-SSH.ps1 -ClientIp YOUR.PUBLIC.IP -ConfirmRestrict
```

Example (verify before use; IPs change): Mac public IP observed during setup was `116.68.104.18`.

Exact one-liner equivalent (admin PowerShell) if you prefer not to use the script:

```powershell
New-NetFirewallRule -DisplayName "GATC SSH allow 116.68.104.18 only" -Direction Inbound -Protocol TCP -LocalPort 22 -RemoteAddress 116.68.104.18 -Action Allow -Profile Any -Enabled True
# Then disable broad OpenSSH allow-any rules carefully — see Restrict-SSH.ps1
```

Do not break RDP. Do not run restrict rules unless the IP is stable and you have RDP access.
