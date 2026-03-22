const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const sequelize = require("../config/database")

const User = sequelize.define('User', {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  
  email: {
    type: DataTypes.STRING(100),
    allowNull: false,
    unique: true,
    validate: {
      isEmail: true
    }
  },
  
  password: {
    type: DataTypes.STRING(255),
    allowNull: false
  },
  
  full_name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  
  phone_number: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  
  role: {
    type: DataTypes.ENUM("commuter", "company_admin", "driver", "admin"),
    defaultValue: 'commuter',
  },
  
  avatar_url: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  
  company_id: {
    type: DataTypes.UUID,
    allowNull: true,
    references: {
      model: 'companies',
      key: 'id'
    }
  },

  must_change_password: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
    allowNull: false
  },
  
  is_active: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
  
  email_verified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },

  company_verified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },

  account_status: {
    type: DataTypes.STRING(50),
    defaultValue: 'approved',
  },

  last_login: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  
  preferences: {
    type: DataTypes.JSON,
    allowNull: true,
    defaultValue: {
      language: 'en',
      notifications: {
        email: true,
        sms: false,
        promotional: false
      }
    }
  },

  permissions: {
    type: DataTypes.JSONB,
    allowNull: true,
    defaultValue: {},
  },
}, {
  tableName: 'users',
  timestamps: true,
  underscored: true,
  validate: {
    driverRequiresCompany() {
      if (this.role === 'driver' && !this.company_id) {
        throw new Error('Driver users must have a company_id');
      }
    }
  },
  hooks: {
    beforeCreate: async (user) => {
      if (user.password) {
        user.password = await bcrypt.hash(user.password, 10);
      }
    },
    beforeUpdate: async (user) => {
      if (user.changed('password')) {
        user.password = await bcrypt.hash(user.password, 10);
      }
    }
  },
  indexes: [
    { fields: ['email'], unique: true },
    { fields: ['role'] },
    { fields: ['company_id'] }
  ]
});

// Instance method to check password
User.prototype.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Instance method to get safe user object (without password)
User.prototype.toSafeObject = function() {
  const { password, ...safeUser } = this.get({ plain: true });
  return safeUser;
};

// Instance method to get public profile (limited fields)
User.prototype.toPublicProfile = function() {
  const { password, email, preferences, ...publicProfile } = this.get({ plain: true });
  return publicProfile;
};

module.exports = User