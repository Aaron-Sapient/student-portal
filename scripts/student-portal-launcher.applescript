-- Student Portal dev launcher
-- Ensures the dev server (port 3000) and tailscale serve are up, then opens the MagicDNS URL.
-- Compiled into /Applications/Student Portal.app via:
--   osacompile -o "/Applications/Student Portal.app" scripts/student-portal-launcher.applescript

set projectPath to "/Users/aaron/Documents/VS Code/student-portal"
set devURL to "https://aarons-macbook-pro.tail4ab0a5.ts.net/"
set logFile to "/tmp/student-portal-dev.log"
set tailscaleBin to "/Applications/Tailscale.app/Contents/MacOS/Tailscale"

on portIsUp()
	set httpCode to do shell script "curl -s -o /dev/null -m 2 -w '%{http_code}' http://127.0.0.1:3000/ || true"
	return httpCode is not "000" and httpCode is not ""
end portIsUp

-- 1. Start the dev server only if nothing is on port 3000
if not portIsUp() then
	do shell script "cd " & quoted form of projectPath & " && PATH=/usr/local/bin:/usr/bin:/bin:/usr/sbin nohup npm run dev > " & quoted form of logFile & " 2>&1 &"

	-- Poll up to 60s for the server to respond
	set serverUp to false
	repeat 60 times
		delay 1
		if portIsUp() then
			set serverUp to true
			exit repeat
		end if
	end repeat

	if not serverUp then
		set logTail to do shell script "tail -n 15 " & quoted form of logFile & " 2>/dev/null || echo '(no log)'"
		display dialog "Dev server failed to start within 60s." & return & return & logTail buttons {"OK"} default button "OK" with icon stop
		return
	end if
end if

-- 2. Make sure tailscale serve is proxying 443 -> 3000 (config normally persists; cheap to verify)
try
	set serveStatus to do shell script quoted form of tailscaleBin & " serve status 2>/dev/null || true"
	if serveStatus does not contain "proxy http://127.0.0.1:3000" then
		do shell script quoted form of tailscaleBin & " serve --bg --https=443 http://127.0.0.1:3000"
	end if
end try

-- 3. Open the MagicDNS URL in the default browser
do shell script "open " & quoted form of devURL
