module.exports = {
  apps: [
    {
      name: "tradeco-backend",
      cwd: __dirname,
      script: "apps/backend/src/index.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PORT: "8080",
      },
    },
    {
      name: "tradeco-event-service",
      cwd: __dirname,
      script: "apps/event-service/src/index.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PORT: "8081",
      },
    },
    {
      name: "tradeco-execution-service",
      cwd: __dirname,
      script: "apps/execution-service/src/index.js",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
      },
    },
    {
      name: "tradeco-frontend",
      cwd: __dirname,
      script: "npm",
      args: "--workspace apps/frontend run start",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        HOSTNAME: "0.0.0.0",
      },
    },
  ],
};
