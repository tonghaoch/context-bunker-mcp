using System;
using System.Collections.Generic;

namespace Auth
{
    /// <summary>Represents a user in the system.</summary>
    public class User
    {
        public int Id { get; set; }
        public string Name { get; set; }

        public User(int id, string name)
        {
            Id = id;
            Name = name;
        }

        /// <summary>Returns the user's display name.</summary>
        public string GetDisplayName()
        {
            return Name;
        }

        private void Validate()
        {
            if (Name.Length > 100)
            {
                throw new ArgumentException("Name too long");
            }
        }
    }

    /// <summary>Defines authentication methods.</summary>
    public interface IAuthenticator
    {
        User Login(string email, string password);
        void Logout(User user);
    }

    /// <summary>User roles in the system.</summary>
    public enum Role
    {
        Admin,
        User,
        Guest
    }

    /// <summary>A simple point struct.</summary>
    public struct Point
    {
        public int X;
        public int Y;
    }

    public delegate void AuthHandler(string message);
}
