import http from 'http';

const options = {
  host: 'localhost',
  port: process.env.PORT || 3000,
  path: '/health',
  timeout: 2000,
};

const request = http.get(options, (res) => {
  if (res.statusCode === 200) {
    process.exit(0);
  } else {
    process.exit(1);
  }
});

request.on('error', (err) => {
  console.error(`Healthcheck failed: ${err.message}`);
  process.exit(1);
});

request.end();
