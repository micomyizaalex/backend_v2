// models/User.js
const { DataTypes, Op } = require('sequelize'); 
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
  
  license_number: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
  },
  
  license_expiry: {
    type: DataTypes.DATE,
    allowNull: true,
  },
  
  driver_notes: {
    type: DataTypes.TEXT,
    allowNull: true,
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

  account_status: {
    type: DataTypes.ENUM("pending", "approved", "suspended", "rejected"),
    defaultValue: 'pending',
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
    companyAdminRequiresCompany() {
      if (this.role === 'company_admin' && !this.company_id) {
        throw new Error('Company admin users must have a company_id');
      }
    },
    driverRequiresCompany() {
      if (this.role === 'driver' && !this.company_id) {
        throw new Error('Driver users must have a company_id');
      }
    },
    driverRequiresLicense() {
      if (this.role === 'driver' && !this.license_number) {
        throw new Error('Driver users must have a license_number');
      }
    },
    commuterNoCompany() {
      if (this.role === 'commuter' && this.company_id) {
        throw new Error('Commuter users cannot have a company_id');
      }
    },
    adminNoCompany() {
      if (this.role === 'admin' && this.company_id) {
        throw new Error('Admin users cannot have a company_id');
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
    { fields: ['company_id'] },
    { fields: ['account_status'] },
    { fields: ['license_number'], unique: true, where: { license_number: { [Op.ne]: null } } }
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
  const { password, email, permissions, preferences, license_number, license_expiry, ...publicProfile } = this.get({ plain: true });
  return publicProfile;
};

module.exports = User;