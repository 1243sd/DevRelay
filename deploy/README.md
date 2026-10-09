# Linux systemd user/system service notes

Edit paths and user in `devrelay.service.example` for your machine. Ensure that `piworker` can access the repository and its Pi/Gemini authentication. Deploy the compiled `dist/` and local `.env` owned by that user and mode 0600. Example (system service, root permissions required):

```sh
sudo cp deploy/devrelay.service.example /etc/systemd/system/devrelay.service
sudo systemctl daemon-reload
sudo systemctl enable --now devrelay
sudo journalctl -u devrelay -f
```

macOS: start-background.sh works until reboot; use `launchd` for auto-start. Windows: launch Node from Task Scheduler (at login) or NSSM, with `WorkingDirectory` set to the project folder. Neither platform is automatically configured by this project.
