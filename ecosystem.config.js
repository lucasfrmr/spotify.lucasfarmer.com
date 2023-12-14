module.exports = {
    apps: [{
      name: 'css-watcher',
      script: 'npx',
      args: 'run build:css',
      watch: ['src/styles.css'],
      ignore_watch: ['node_modules', 'public'],
      watch_options: {
        followSymlinks: false
      }
    }]
  };
