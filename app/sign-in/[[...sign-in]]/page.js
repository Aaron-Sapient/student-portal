import { SignIn } from '@clerk/nextjs'

export default function SignInPage() {
  return (
    <main style={{ display: 'flex', justifyContent: 'center', marginTop: '100px' }}>
      <SignIn />
    </main>
  )
}