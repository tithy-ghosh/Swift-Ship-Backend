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

  const server = app.listen(env.port)

  server.on('error', () => {
    process.exit(1)
  })
}

startServer().catch(() => {
  process.exit(1)
})
