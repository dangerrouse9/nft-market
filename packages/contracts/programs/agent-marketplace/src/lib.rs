use anchor_lang::prelude::*;
use anchor_lang::system_program::{transfer, Transfer};
use mpl_core::accounts::BaseAssetV1;
use mpl_core::instructions::TransferV1CpiBuilder;

declare_id!("2nPNgif9RKG2axFKZAuzH4Gx9A5B51wBaNQDcbKKgbqT");

/// Metaplex Agent Registry — Agent Identity program ("014" registry).
pub const AGENT_IDENTITY_PROGRAM: Pubkey =
    Pubkey::from_str_const("1DREGFgysWYxLnRnKQnwrxnJQeSMk2HmGaC6whw2B2p");

pub const CONFIG_SEED: &[u8] = b"config";
pub const LISTING_SEED: &[u8] = b"listing";
pub const ESCROW_SEED: &[u8] = b"escrow";
pub const AGENT_IDENTITY_SEED: &[u8] = b"agent_identity";

const BPS_DENOMINATOR: u128 = 10_000;

#[program]
pub mod agent_marketplace {
    use super::*;

    /// One-time setup: stores the marketplace fee and fee wallet.
    pub fn initialize_config(ctx: Context<InitializeConfig>, fee_bps: u16) -> Result<()> {
        require!(fee_bps <= 2_000, MarketplaceError::FeeTooHigh);
        let config = &mut ctx.accounts.config;
        config.admin = ctx.accounts.admin.key();
        config.marketplace_wallet = ctx.accounts.marketplace_wallet.key();
        config.fee_bps = fee_bps;
        config.bump = ctx.bumps.config;
        Ok(())
    }

    /// Lists a Core asset for sale. The asset moves into a program-controlled
    /// escrow so `buy` can transfer it without the seller signing again.
    pub fn list(ctx: Context<List>, price_lamports: u64, royalty_bps: u16) -> Result<()> {
        require!(price_lamports > 0, MarketplaceError::InvalidPrice);
        require!(royalty_bps <= 5_000, MarketplaceError::RoyaltyTooHigh);

        {
            let data = ctx.accounts.asset.try_borrow_data()?;
            let asset = BaseAssetV1::from_bytes(&data)
                .map_err(|_| MarketplaceError::InvalidAssetData)?;
            require_keys_eq!(
                asset.owner,
                ctx.accounts.seller.key(),
                MarketplaceError::NotAssetOwner
            );
        }

        let listing = &mut ctx.accounts.listing;
        listing.seller = ctx.accounts.seller.key();
        listing.creator = ctx.accounts.creator.key();
        listing.asset = ctx.accounts.asset.key();
        listing.price_lamports = price_lamports;
        listing.royalty_bps = royalty_bps;
        listing.bump = ctx.bumps.listing;

        let mpl_core_ai = ctx.accounts.mpl_core_program.to_account_info();
        let asset_ai = ctx.accounts.asset.to_account_info();
        let seller_ai = ctx.accounts.seller.to_account_info();
        let escrow_ai = ctx.accounts.escrow_authority.to_account_info();
        let system_ai = ctx.accounts.system_program.to_account_info();
        let collection_ai = ctx.accounts.collection.as_ref().map(|c| c.to_account_info());

        TransferV1CpiBuilder::new(&mpl_core_ai)
            .asset(&asset_ai)
            .collection(collection_ai.as_ref())
            .payer(&seller_ai)
            .authority(Some(&seller_ai))
            .new_owner(&escrow_ai)
            .system_program(Some(&system_ai))
            .invoke()?;

        emit!(Listed {
            asset: ctx.accounts.asset.key(),
            seller: ctx.accounts.seller.key(),
            price_lamports,
        });
        Ok(())
    }

    /// Executes a purchase. Only wallets holding a Core asset registered on
    /// the Metaplex Agent Identity registry may buy. Payment is split between
    /// seller, creator (royalty) and the marketplace wallet (fee), then the
    /// NFT is released from escrow to the buyer.
    pub fn buy(ctx: Context<Buy>) -> Result<()> {
        // --- Agent gate -------------------------------------------------
        let (expected_identity, _) = Pubkey::find_program_address(
            &[
                AGENT_IDENTITY_SEED,
                ctx.accounts.buyer_agent_asset.key().as_ref(),
            ],
            &AGENT_IDENTITY_PROGRAM,
        );
        require_keys_eq!(
            ctx.accounts.buyer_agent_identity.key(),
            expected_identity,
            MarketplaceError::NotARegisteredAgent
        );
        require!(
            !ctx.accounts.buyer_agent_identity.data_is_empty(),
            MarketplaceError::NotARegisteredAgent
        );
        require_keys_eq!(
            *ctx.accounts.buyer_agent_identity.owner,
            AGENT_IDENTITY_PROGRAM,
            MarketplaceError::NotARegisteredAgent
        );
        // The registered agent asset must belong to the buyer, so one agent
        // registration can't be borrowed by arbitrary wallets.
        {
            let data = ctx.accounts.buyer_agent_asset.try_borrow_data()?;
            let agent_asset = BaseAssetV1::from_bytes(&data)
                .map_err(|_| MarketplaceError::InvalidAssetData)?;
            require_keys_eq!(
                agent_asset.owner,
                ctx.accounts.buyer.key(),
                MarketplaceError::AgentNotOwnedByBuyer
            );
        }

        // --- Payment split ----------------------------------------------
        let listing = &ctx.accounts.listing;
        let config = &ctx.accounts.config;
        let price = listing.price_lamports;

        let royalty = ((price as u128 * listing.royalty_bps as u128) / BPS_DENOMINATOR) as u64;
        let fee = ((price as u128 * config.fee_bps as u128) / BPS_DENOMINATOR) as u64;
        let seller_base = price
            .checked_sub(royalty)
            .and_then(|v| v.checked_sub(fee))
            .ok_or(MarketplaceError::MathOverflow)?;

        // When the seller is also the royalty recipient (a primary sale), the
        // creator account is omitted — Solana rejects the same writable
        // account passed twice — and the royalty goes to the seller.
        let (seller_amount, creator_amount) = match &ctx.accounts.creator {
            Some(creator) => {
                require_keys_eq!(
                    creator.key(),
                    listing.creator,
                    MarketplaceError::InvalidCreator
                );
                (seller_base, royalty)
            }
            None => {
                require_keys_eq!(
                    listing.creator,
                    listing.seller,
                    MarketplaceError::InvalidCreator
                );
                (seller_base + royalty, 0)
            }
        };

        let system_ai = ctx.accounts.system_program.to_account_info();
        let buyer_ai = ctx.accounts.buyer.to_account_info();

        if seller_amount > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Transfer {
                        from: buyer_ai.clone(),
                        to: ctx.accounts.seller.to_account_info(),
                    },
                ),
                seller_amount,
            )?;
        }
        if creator_amount > 0 {
            if let Some(creator) = &ctx.accounts.creator {
                transfer(
                    CpiContext::new(
                        ctx.accounts.system_program.key(),
                        Transfer {
                            from: buyer_ai.clone(),
                            to: creator.to_account_info(),
                        },
                    ),
                    creator_amount,
                )?;
            }
        }
        if fee > 0 {
            transfer(
                CpiContext::new(
                    ctx.accounts.system_program.key(),
                    Transfer {
                        from: buyer_ai.clone(),
                        to: ctx.accounts.marketplace_wallet.to_account_info(),
                    },
                ),
                fee,
            )?;
        }

        // --- Release the NFT from escrow ---------------------------------
        let asset_key = ctx.accounts.asset.key();
        let escrow_bump = ctx.bumps.escrow_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[ESCROW_SEED, asset_key.as_ref(), &[escrow_bump]]];

        let mpl_core_ai = ctx.accounts.mpl_core_program.to_account_info();
        let asset_ai = ctx.accounts.asset.to_account_info();
        let escrow_ai = ctx.accounts.escrow_authority.to_account_info();
        let collection_ai = ctx.accounts.collection.as_ref().map(|c| c.to_account_info());

        TransferV1CpiBuilder::new(&mpl_core_ai)
            .asset(&asset_ai)
            .collection(collection_ai.as_ref())
            .payer(&buyer_ai)
            .authority(Some(&escrow_ai))
            .new_owner(&buyer_ai)
            .system_program(Some(&system_ai))
            .invoke_signed(signer_seeds)?;

        emit!(Purchased {
            asset: asset_key,
            buyer: ctx.accounts.buyer.key(),
            seller: listing.seller,
            creator: listing.creator,
            price_lamports: price,
            royalty_lamports: creator_amount,
            fee_lamports: fee,
        });
        Ok(())
    }

    /// Cancels a listing: returns the escrowed asset to the seller.
    pub fn delist(ctx: Context<Delist>) -> Result<()> {
        let asset_key = ctx.accounts.asset.key();
        let escrow_bump = ctx.bumps.escrow_authority;
        let signer_seeds: &[&[&[u8]]] = &[&[ESCROW_SEED, asset_key.as_ref(), &[escrow_bump]]];

        let mpl_core_ai = ctx.accounts.mpl_core_program.to_account_info();
        let asset_ai = ctx.accounts.asset.to_account_info();
        let seller_ai = ctx.accounts.seller.to_account_info();
        let escrow_ai = ctx.accounts.escrow_authority.to_account_info();
        let system_ai = ctx.accounts.system_program.to_account_info();
        let collection_ai = ctx.accounts.collection.as_ref().map(|c| c.to_account_info());

        TransferV1CpiBuilder::new(&mpl_core_ai)
            .asset(&asset_ai)
            .collection(collection_ai.as_ref())
            .payer(&seller_ai)
            .authority(Some(&escrow_ai))
            .new_owner(&seller_ai)
            .system_program(Some(&system_ai))
            .invoke_signed(signer_seeds)?;

        emit!(Delisted {
            asset: asset_key,
            seller: ctx.accounts.seller.key(),
        });
        Ok(())
    }
}

#[derive(Accounts)]
pub struct InitializeConfig<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        init,
        payer = admin,
        space = 8 + Config::INIT_SPACE,
        seeds = [CONFIG_SEED],
        bump
    )]
    pub config: Account<'info, Config>,
    /// CHECK: any wallet may receive marketplace fees
    pub marketplace_wallet: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct List<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    /// CHECK: deserialized as a Core asset; ownership checked in the handler
    /// and validity enforced by mpl-core during the transfer CPI
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: optional Core collection the asset belongs to
    #[account(mut)]
    pub collection: Option<UncheckedAccount<'info>>,
    /// CHECK: royalty recipient, stored on the listing
    pub creator: UncheckedAccount<'info>,
    #[account(
        init,
        payer = seller,
        space = 8 + Listing::INIT_SPACE,
        seeds = [LISTING_SEED, asset.key().as_ref()],
        bump
    )]
    pub listing: Account<'info, Listing>,
    /// CHECK: PDA that owns the asset while it is listed
    #[account(seeds = [ESCROW_SEED, asset.key().as_ref()], bump)]
    pub escrow_authority: UncheckedAccount<'info>,
    /// CHECK: constrained to the mpl-core program id
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    /// CHECK: the buyer's registered agent Core asset; ownership checked in handler
    pub buyer_agent_asset: UncheckedAccount<'info>,
    /// CHECK: AgentIdentity PDA of the registry, validated in the handler
    pub buyer_agent_identity: UncheckedAccount<'info>,
    #[account(seeds = [CONFIG_SEED], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        close = seller,
        seeds = [LISTING_SEED, asset.key().as_ref()],
        bump = listing.bump,
        has_one = seller,
        has_one = asset
    )]
    pub listing: Account<'info, Listing>,
    /// CHECK: the escrowed Core asset being purchased
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: optional Core collection the asset belongs to
    #[account(mut)]
    pub collection: Option<UncheckedAccount<'info>>,
    /// CHECK: escrow PDA that currently owns the asset
    #[account(seeds = [ESCROW_SEED, asset.key().as_ref()], bump)]
    pub escrow_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub seller: SystemAccount<'info>,
    /// CHECK: royalty recipient; must match listing.creator (checked in handler).
    /// Omitted on primary sales where seller == creator.
    #[account(mut)]
    pub creator: Option<UncheckedAccount<'info>>,
    /// CHECK: fee wallet, constrained to the configured address
    #[account(mut, address = config.marketplace_wallet)]
    pub marketplace_wallet: UncheckedAccount<'info>,
    /// CHECK: constrained to the mpl-core program id
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Delist<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(
        mut,
        close = seller,
        seeds = [LISTING_SEED, asset.key().as_ref()],
        bump = listing.bump,
        has_one = seller,
        has_one = asset
    )]
    pub listing: Account<'info, Listing>,
    /// CHECK: the escrowed Core asset being delisted
    #[account(mut)]
    pub asset: UncheckedAccount<'info>,
    /// CHECK: optional Core collection the asset belongs to
    #[account(mut)]
    pub collection: Option<UncheckedAccount<'info>>,
    /// CHECK: escrow PDA that currently owns the asset
    #[account(seeds = [ESCROW_SEED, asset.key().as_ref()], bump)]
    pub escrow_authority: UncheckedAccount<'info>,
    /// CHECK: constrained to the mpl-core program id
    #[account(address = mpl_core::ID)]
    pub mpl_core_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub marketplace_wallet: Pubkey,
    pub fee_bps: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Listing {
    pub seller: Pubkey,
    pub creator: Pubkey,
    pub asset: Pubkey,
    pub price_lamports: u64,
    pub royalty_bps: u16,
    pub bump: u8,
}

#[event]
pub struct Listed {
    pub asset: Pubkey,
    pub seller: Pubkey,
    pub price_lamports: u64,
}

#[event]
pub struct Purchased {
    pub asset: Pubkey,
    pub buyer: Pubkey,
    pub seller: Pubkey,
    pub creator: Pubkey,
    pub price_lamports: u64,
    pub royalty_lamports: u64,
    pub fee_lamports: u64,
}

#[event]
pub struct Delisted {
    pub asset: Pubkey,
    pub seller: Pubkey,
}

#[error_code]
pub enum MarketplaceError {
    #[msg("Buyer is not a registered agent on the Metaplex Agent Identity registry")]
    NotARegisteredAgent,
    #[msg("The agent identity asset is not owned by the buyer")]
    AgentNotOwnedByBuyer,
    #[msg("Seller does not own this asset")]
    NotAssetOwner,
    #[msg("Account data is not a valid Core asset")]
    InvalidAssetData,
    #[msg("Price must be greater than zero")]
    InvalidPrice,
    #[msg("Marketplace fee exceeds 20%")]
    FeeTooHigh,
    #[msg("Royalty exceeds 50%")]
    RoyaltyTooHigh,
    #[msg("Creator account does not match the listing")]
    InvalidCreator,
    #[msg("Arithmetic overflow")]
    MathOverflow,
}
