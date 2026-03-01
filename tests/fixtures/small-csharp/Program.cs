using System;
using Auth;

namespace App
{
    /// <summary>Main application entry point.</summary>
    public class Program
    {
        public static void Main(string[] args)
        {
            AuthService service = new AuthService();
            User user = service.Login("admin@test.com", "secret123");
            Console.WriteLine("Welcome " + user.GetDisplayName());
        }

        public static string GetAppName()
        {
            return "small-csharp";
        }
    }
}
