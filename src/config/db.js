import dns from 'node:dns'
import mongoose from 'mongoose'
import { requireEnv } from './env.js'

// Public resolvers avoid local ISP DNS failures when resolving MongoDB Atlas SRV records.
dns.setServers(['8.8.8.8', '1.1.1.1'])

/**
 * Connects Mongoose to the configured database.
 *
 * @returns {Promise<typeof mongoose>}
 */
const connectDatabase = async () => {
  const connection = await mongoose.connect(requireEnv('MONGODB_URI'))
  console.log('MongoDB connected')
  return connection
}

export default connectDatabase
