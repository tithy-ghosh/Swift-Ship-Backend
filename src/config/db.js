import dns from 'node:dns'
import mongoose from 'mongoose'
import { requireEnv } from './env.js'

const dnsResolvers = ['8.8.8.8', '1.1.1.1', '8.8.4.4', '1.0.0.1']
const retryableDnsErrors = new Set(['ECONNREFUSED', 'ETIMEOUT', 'ESERVFAIL'])

/**
 * Connects Mongoose to the configured database.
 *
 * @returns {Promise<typeof mongoose>}
 */
const connectDatabase = async () => {
  const uri = requireEnv('MONGODB_URI')

  for (const [index, resolver] of dnsResolvers.entries()) {
    // Try public resolvers individually because local and public DNS can
    // intermittently refuse MongoDB Atlas SRV queries on this network.
    dns.setServers([resolver])

    try {
      const connection = await mongoose.connect(uri, {
        // Prefer IPv4 because this network exposes unreachable DNS64 addresses.
        family: 4,
        serverSelectionTimeoutMS: 10000,
      })
      console.log('MongoDB connected')
      return connection
    } catch (error) {
      const hasAnotherResolver = index < dnsResolvers.length - 1
      if (!hasAnotherResolver || !retryableDnsErrors.has(error.code)) {
        throw error
      }
    }
  }

  throw new Error('MongoDB connection failed')
}

export default connectDatabase
