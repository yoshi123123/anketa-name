SAFE DEPLOY — IMPORTANT

This merged version intentionally DOES NOT include db.sqlite, db.sqlite-wal, db.sqlite-shm, .env, node_modules, or uploads.
That protects your existing live database from being overwritten during deploy.

Before deploy:
1) Make a backup of the live database:
   cp db.sqlite db_backup_$(date +%F_%H-%M).sqlite
   cp db.sqlite-wal db_backup_$(date +%F_%H-%M).sqlite-wal 2>/dev/null || true
   cp db.sqlite-shm db_backup_$(date +%F_%H-%M).sqlite-shm 2>/dev/null || true

2) Backup uploads and .env:
   cp -r public/uploads uploads_backup_$(date +%F_%H-%M) 2>/dev/null || true
   cp .env env_backup_$(date +%F_%H-%M) 2>/dev/null || true

3) Upload only code files. Do not overwrite your live db.sqlite or .env.

Railway note:
- If you use SQLite on Railway, set a persistent Volume and DB_PATH to a path inside the volume.
- If db.sqlite is stored only inside the app folder without a volume, it can be lost on redeploy.

This server.js also creates an automatic backup in ./backups before migrations unless AUTO_DB_BACKUP=0.
