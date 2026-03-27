import { createSignal } from 'solid-js';
import { A } from '@solidjs/router';

export function Login() {
  const [email, setEmail] = createSignal('');
  const [password, setPassword] = createSignal('');
  const [error, setError] = createSignal('');

  const handleLogin = async (e: Event) => {
    e.preventDefault();
    setError('');
    
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: email(), password: password() }),
      });
      
      if (res.ok) {
        window.location.href = '/';
      } else {
        const data = await res.json();
        setError(data.error || 'Login failed');
      }
    } catch {
      setError('An error occurred. Please try again.');
    }
  };

  return (
    <div class="min-h-screen flex items-center justify-center bg-pattern p-4">
      <div class="glass-card w-full max-w-sm rounded-2xl p-8 animate-fade-in">
        <div class="text-center mb-8">
          <div class="inline-flex items-center justify-center w-16 h-16 rounded-full bg-primary/10 text-primary mb-4">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-8 h-8">
              <path stroke-linecap="round" stroke-linejoin="round" d="M17.982 18.725A7.488 7.488 0 0012 15.75a7.488 7.488 0 00-5.982 2.975m11.963 0a9 9 0 10-11.963 0m11.963 0A8.966 8.966 0 0112 21a8.966 8.966 0 01-5.982-2.275M15 9.75a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <h2 class="text-3xl font-bold text-neutral">Welcome back</h2>
          <p class="text-sm opacity-60 mt-2">Sign in to track your groceries</p>
        </div>
        
        <form onSubmit={handleLogin} class="space-y-5">
          {error() && (
            <div class="alert alert-error py-3 text-sm rounded-xl">
              <svg xmlns="http://www.w3.org/2000/svg" class="stroke-current shrink-0 w-5 h-5" fill="none" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
              <span>{error()}</span>
            </div>
          )}
          
          <div class="form-control">
            <label class="label">
              <span class="label-text font-medium text-sm">Email</span>
            </label>
            <input 
              type="email" 
              placeholder="you@example.com" 
              class="input input-bordered w-full bg-base-100/50" 
              value={email()} 
              onInput={(e) => setEmail(e.currentTarget.value)} 
              required
            />
          </div>
          
          <div class="form-control">
            <label class="label">
              <span class="label-text font-medium text-sm">Password</span>
            </label>
            <input 
              type="password" 
              placeholder="••••••••" 
              class="input input-bordered w-full bg-base-100/50" 
              value={password()} 
              onInput={(e) => setPassword(e.currentTarget.value)} 
              required
            />
          </div>
          
          <div class="form-control mt-6">
            <button type="submit" class="btn btn-primary w-full">Sign In</button>
          </div>
        </form>
        
        <div class="mt-6 text-center text-sm">
          <span class="opacity-60">Don't have an account? </span>
          <A href="/register" class="font-medium text-primary hover:underline">Create one</A>
        </div>
      </div>
    </div>
  );
}
