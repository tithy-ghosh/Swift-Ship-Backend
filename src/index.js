import 'dotenv/config'
import app from './app.js'
import connectDatabase from './config/db.js'
import { env } from './config/env.js'

/**
 * Starts infrastructure before accepting traffic. A failed database connection
 * rejects startup instead of leaving a partially functional process running.
 */
const startServer = async () => {
  await connectDatabase()

  const server = app.listen(env.port, () => {
    console.log(`Server running on http://localhost:${env.port}`)
  })

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${env.port} is already in use. Stop the existing server and try again.`)
    } else {
      console.error('HTTP server failed:', error)
    }
    process.exit(1)
  })
}

startServer().catch((error) => {
  console.error('Server startup failed:', error)
  process.exit(1)
})
