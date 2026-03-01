using System;

namespace Auth
{
    /// <summary>Service that handles authentication logic.</summary>
    public class AuthService : IAuthenticator
    {
        public User Login(string email, string password)
        {
            Console.WriteLine("Login attempt: " + email);
            User user = new User(1, email);
            return user;
        }

        public void Logout(User user)
        {
            Console.WriteLine("Logout: " + user.GetDisplayName());
        }

        public bool ValidateCredentials(string email, string password)
        {
            return email != null && password != null && password.Length >= 8;
        }
    }
}
