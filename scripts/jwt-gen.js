#!/usr/bin/env node
import { SignJWT } from 'jose'

async function main() {
  const userId = process.argv[2] || 'user-' + Math.random().toString(36).slice(2, 10)
  const secret = process.env.JWT_SECRET || 'your-super-secret-key-change-this-in-production'

  const jwt = await new SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(new TextEncoder().encode(secret))

  console.log('='.repeat(60))
  console.log('JWT Generated')
  console.log('='.repeat(60))
  console.log('User ID:', userId)
  console.log()
  console.log('Token:')
  console.log(jwt)
  console.log()
  console.log('Use in admin dashboard or as Authorization header:')
  console.log(`Authorization: Bearer ${jwt}`)
  console.log('='.repeat(60))
}

main().catch(console.error)
