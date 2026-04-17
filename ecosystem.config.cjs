module.exports = {
  apps: [{
    name:             'streamapp',
    script:           './server/index.js',
    interpreter:      'node',
    interpreter_args: '--experimental-vm-modules',
    instances:        1,          
    exec_mode:        'fork',
    env_file:         '/home/ubuntu/app/.env',
    max_memory_restart: '1500M',
    watch:            false,
    error_file:       './logs/error.log',
    out_file:         './logs/out.log',
    log_date_format:  'YYYY-MM-DD HH:mm:ss',
    cron_restart:     '0 4 * * *', 
  }],
};
