from algopy import *
from algopy.arc4 import abimethod

class PayStream(ARC4Contract):
    # The Employer (Admin) who owns this vault
    admin: Account
    # Track total deposited for accounting (MVP feature)
    total_deposited: UInt64

    def __init__(self) -> None:
        self.admin = Txn.sender
        self.total_deposited = UInt64(0)

    @abimethod(allow_actions=["OptIn"])
    def opt_in_to_asset(self, asset: Asset) -> None:
        """
        Vault must opt-in to USDCa to hold it.
        Only admin can trigger this to prevent spam.
        """
        assert Txn.sender == self.admin, "Only admin can opt-in to assets"
        itxn.AssetTransfer(
            xfer_asset=asset,
            asset_receiver=Global.current_application_address,
            asset_amount=0,
            fee=0 # Fee must be covered by the outer transaction
        ).submit()

    @abimethod
    def deposit(self, txn: gtxn.AssetTransferTransaction) -> None:
        """
        Log a deposit. 
        The actual money transfer happens in the atomic group, 
        this method just validates it went to the vault.
        """
        assert txn.asset_receiver == Global.current_application_address, "Deposit must be to this contract"
        self.total_deposited += txn.asset_amount

    @abimethod
    def payout(self, recipient: Account, asset: Asset, amount: UInt64) -> None:
        """
        The PayStream Core: Release funds to a contractor.
        """
        assert Txn.sender == self.admin, "Only admin can initiate payouts"
        
        # Inner Transaction: Send USDCa to contractor
        itxn.AssetTransfer(
            xfer_asset=asset,
            asset_receiver=recipient,
            asset_amount=amount,
            fee=0 # Employer pays the fee
        ).submit()

    @abimethod
    def withdraw_admin(self, asset: Asset, amount: UInt64) -> None:
        """
        Rug pull protection? No, just letting the employer get their money back.
        """
        assert Txn.sender == self.admin, "Only admin can withdraw"
        itxn.AssetTransfer(
            xfer_asset=asset,
            asset_receiver=self.admin,
            asset_amount=amount,
            fee=0
        ).submit()